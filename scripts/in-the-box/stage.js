// Headless three.js stage for the "in the box" flat-lay renders. Loaded by
// scripts/in-the-box/render.mjs in Playwright Chromium; exposes
// window.inTheBox.{probe, render}. Units inside the stage are the GLB's
// (metres); every GLB part keeps its real size, so relative scale is true.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {buildProcedural, drawArt} from './procedural.js';

const cleanName = (n) =>
  String(n || '')
    .replace(/^occurrence of\s+/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim();

// ---- Loading ---------------------------------------------------------------

async function loadSource(url, sourceIndex) {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  gltf.scene.updateMatrixWorld(true);
  const json = gltf.parser.json;
  const byNode = new Map();
  gltf.scene.traverse((o) => {
    const a = gltf.parser.associations.get(o);
    if (a && a.nodes !== undefined && !byNode.has(a.nodes)) byNode.set(a.nodes, o);
  });
  const parts = new Map();
  json.nodes.forEach((node, i) => {
    if (node.mesh === undefined) return;
    const obj = byNode.get(i);
    if (!obj) return;
    const name = cleanName(node.name);
    const key = `${sourceIndex}:${name}#${node.mesh}`;
    if (!parts.has(key)) parts.set(key, {key, name, mesh: node.mesh, source: sourceIndex, objects: []});
    parts.get(key).objects.push(obj);
  });
  return [...parts.values()];
}

async function loadAll(sources) {
  const all = [];
  for (let i = 0; i < sources.length; i++) all.push(...(await loadSource(sources[i], i)));
  return all;
}

// ---- Geometry helpers ------------------------------------------------------

function worldPoints(obj, max = 30000) {
  const pts = [];
  const v = new THREE.Vector3();
  obj.updateMatrixWorld(true);
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / max));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      pts.push(v.clone());
    }
  });
  return pts;
}

function jacobiEigen(a) {
  // Symmetric 3x3 eigen decomposition; returns column eigenvectors.
  const m = a.map((r) => r.slice());
  const vec = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += m[p][q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(m[p][q]) < 1e-30) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const mkp = m[k][p];
          const mkq = m[k][q];
          m[k][p] = c * mkp - s * mkq;
          m[k][q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < 3; k++) {
          const mpk = m[p][k];
          const mqk = m[q][k];
          m[p][k] = c * mpk - s * mqk;
          m[q][k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = vec[k][p];
          const vkq = vec[k][q];
          vec[k][p] = c * vkp - s * vkq;
          vec[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return [0, 1, 2].map((j) => new THREE.Vector3(vec[0][j], vec[1][j], vec[2][j]).normalize());
}

function extentAlong(pts, axis) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    const d = p.dot(axis);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return {lo, hi, size: hi - lo};
}

// Rotation that lays the part flat: the axis (world or principal) with the
// smallest extent becomes vertical, the flatter side faces down, then the
// part is turned about the vertical to its minimum-area footprint with the
// long side along Z (image vertical) unless lay:"x".
function flatRotation(pts, lay, forcedUp, keepYaw) {
  const c = new THREE.Vector3();
  pts.forEach((p) => c.add(p));
  c.divideScalar(pts.length);
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d = [p.x - c.x, p.y - c.y, p.z - c.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const bases = [
    [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)],
    jacobiEigen(cov),
  ];
  let best = null;
  for (const basis of bases) {
    const ext = basis.map((a) => extentAlong(pts, a).size);
    const upIdx = ext.indexOf(Math.min(...ext));
    const vol = ext[0] * ext[1] * ext[2];
    if (!best || ext[upIdx] < best.h * 0.98 || (ext[upIdx] < best.h * 1.02 && vol < best.vol)) {
      best = {up: basis[upIdx].clone(), h: ext[upIdx], vol};
    }
  }
  // Flat side down: put the end of the up axis with more points near it down.
  const {lo, hi, size} = extentAlong(pts, best.up);
  const band = size * 0.04;
  let nearLo = 0;
  let nearHi = 0;
  for (const p of pts) {
    const d = p.dot(best.up);
    if (d - lo < band) nearLo++;
    if (hi - d < band) nearHi++;
  }
  let up = best.up.clone();
  if (nearHi > nearLo) up.negate(); // the "lo" end becomes the bottom
  if (forcedUp) up = new THREE.Vector3(...forcedUp).normalize();
  const q1 = new THREE.Quaternion().setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
  if (keepYaw) return q1;
  // In-plane minimum-area footprint.
  const flat = pts.map((p) => p.clone().applyQuaternion(q1));
  let bestA = {area: Infinity, ang: 0, w: 0, d: 0};
  for (let deg = 0; deg < 180; deg += 0.5) {
    const a = (deg * Math.PI) / 180;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of flat) {
      const x = p.x * ca - p.z * sa;
      const z = p.x * sa + p.z * ca;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const area = (x1 - x0) * (z1 - z0);
    if (area < bestA.area - 1e-12) bestA = {area, ang: a, w: x1 - x0, d: z1 - z0};
  }
  let ang = bestA.ang;
  const longAlongX = bestA.w > bestA.d;
  if ((lay === 'x') !== longAlongX) ang += Math.PI / 2;
  // Rotation about Y by -ang matches the (x,z) mapping above.
  const q2 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang);
  return q2.multiply(q1);
}

// ---- Materials -------------------------------------------------------------

// Finishes. `extra` overrides material fields (roughness, ...).
export function finishMaterial(finish, src, override, extra = {}) {
  // CAD exports write sRGB appearance values into glTF's linear factors;
  // read them back as sRGB so gold is #ffb700, not a paler yellow.
  const base = override ? new THREE.Color(override) : src && src.color ? src.color.clone().convertSRGBToLinear()
    : new THREE.Color('#888888');
  const pick = (dflt) => (override ? base : new THREE.Color(dflt));
  let m;
  switch (finish) {
    case 'carbon':
      m = new THREE.MeshPhysicalMaterial({color: pick('#1a1b1f'), roughness: 1.0, metalness: 0.0, clearcoat: 0.5,
        clearcoatRoughness: 0.3});
      break;
    case 'tpu':
      m = new THREE.MeshPhysicalMaterial({color: base, roughness: 0.68, metalness: 0, sheen: 0.25, sheenRoughness: 0.8});
      break;
    case 'alu':
      // Anodised, bead-blasted: satin, not mirror.
      m = new THREE.MeshPhysicalMaterial({color: base, roughness: 0.45, metalness: 0.8, clearcoat: 0.15,
        clearcoatRoughness: 0.5});
      break;
    case 'steel':
      m = new THREE.MeshStandardMaterial({color: pick('#5a5f67'), roughness: 0.3, metalness: 0.9});
      break;
    case 'zinc':
      m = new THREE.MeshStandardMaterial({color: pick('#aeb4bb'), roughness: 0.3, metalness: 0.95});
      break;
    case 'gold':
      m = new THREE.MeshStandardMaterial({color: pick('#d9a531'), roughness: 0.28, metalness: 1.0});
      break;
    case 'rubber':
      m = new THREE.MeshStandardMaterial({color: base, roughness: 0.88, metalness: 0});
      break;
    case 'silicone':
      m = new THREE.MeshPhysicalMaterial({color: base, roughness: 0.42, metalness: 0, clearcoat: 0.25,
        clearcoatRoughness: 0.4});
      break;
    case 'nylon':
      m = new THREE.MeshStandardMaterial({color: base, roughness: 0.55, metalness: 0});
      break;
    default:
      m = new THREE.MeshStandardMaterial({color: base, roughness: 0.5, metalness: 0.1});
  }
  Object.assign(m, extra);
  return m;
}

function applyFinish(obj, finish, override, extra) {
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const next = mats.map((src) => finishMaterial(finish, src, override, extra));
    m.material = Array.isArray(m.material) ? next : next[0];
    m.castShadow = true;
    m.receiveShadow = true;
  });
}

// Carbon 2x2 twill, ~2 mm tows. Warp and weft differ mainly in gloss (the
// way real twill catches light), a little in tone; each tow is shaded
// across its width. Projected top-down onto the flattened part.
let weave = null;
function weaveTextures() {
  if (weave) return weave;
  const n = 8;
  const px = 24;
  const col = document.createElement('canvas');
  col.width = col.height = n * px;
  const rough = document.createElement('canvas');
  rough.width = rough.height = n * px;
  const c = col.getContext('2d');
  const r = rough.getContext('2d');
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      // Warp tow i is on top at weft row j for two rows, then under for two,
      // stepping one tow per row: the diagonal of a 2x2 twill.
      const warp = (((j - i) % 4) + 4) % 4 < 2;
      for (let k = 0; k < px; k++) {
        const t = Math.sin((Math.PI * (k + 0.5)) / px);
        const l = Math.round((warp ? 30 : 26) + 4 * t);
        const ro = Math.round((warp ? 80 : 125) - 25 * t);
        c.fillStyle = `rgb(${l},${l + 1},${l + 3})`;
        r.fillStyle = `rgb(${ro},${ro},${ro})`;
        if (warp) {
          c.fillRect(i * px + k, j * px, 1, px);
          r.fillRect(i * px + k, j * px, 1, px);
        } else {
          c.fillRect(i * px, j * px + k, px, 1);
          r.fillRect(i * px, j * px + k, px, 1);
        }
      }
      // Hairline gap between tows.
      c.fillStyle = 'rgba(8,8,10,0.55)';
      c.fillRect(i * px, j * px, 1, px);
      c.fillRect(i * px, j * px, px, 1);
    }
  }
  const mk = (cv, srgb) => {
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 16;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  weave = {map: mk(col, true), roughnessMap: mk(rough, false), periodM: n * 0.002};
  return weave;
}

// Top-down UVs in the flattened frame: world-periodic (carbon weave) or
// normalised to the item's footprint (printed decals).
function projectUv(holder, fn) {
  holder.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  holder.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    const pos = g.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const [a, b] = fn(v);
      uv[i * 2] = a;
      uv[i * 2 + 1] = b;
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    m.geometry = g;
  });
}

function carbonize(holder) {
  const {map, roughnessMap, periodM} = weaveTextures();
  projectUv(holder, (v) => [v.x / periodM, v.z / periodM]);
  const edges = [];
  holder.traverse((m) => {
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      mat.map = map;
      mat.roughnessMap = roughnessMap;
      mat.color.set('#ffffff');
      mat.needsUpdate = true;
    }
    edges.push(m);
  });
  outline(edges);
}

// Machined edges read lighter than a black face: outline the hard edges so
// black carbon and black anodised parts keep their shape on a dark page.
function outline(meshes, color = '#6b6f78', opacity = 0.7) {
  for (const m of meshes) {
    const line = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30),
      new THREE.LineBasicMaterial({color, transparent: true, opacity}));
    line.matrixAutoUpdate = false;
    line.matrix.copy(m.matrix);
    m.parent.add(line);
  }
}

// Printed artwork on a part's top face (the anti-slip pad's wordmark).
async function applyDecal(holder, decal, assets, size) {
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder, true);
  const wMm = size.x * 1000;
  const dMm = size.z * 1000;
  const c = document.createElement('canvas');
  c.width = Math.round(wMm * 16);
  c.height = Math.round(dMm * 16);
  const g = c.getContext('2d');
  g.fillStyle = decal.base || '#35383d';
  g.fillRect(0, 0, c.width, c.height);
  const art = assets[decal.art];
  if (!art) throw new Error(`decal artwork missing: ${decal.art}`);
  const fw = decal.widthFrac ?? 0.55;
  g.globalAlpha = decal.alpha ?? 0.9;
  await drawArt(g, art, c.width * (1 - fw) / 2, c.height * 0.2, c.width * fw, c.height * 0.6, decal.color);
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  projectUv(holder, (v) => [(v.x - box.min.x) / (box.max.x - box.min.x), 1 - (v.z - box.min.z) / (box.max.z - box.min.z)]);
  holder.traverse((m) => {
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      mat.map = tex;
      mat.color.set('#ffffff');
      mat.needsUpdate = true;
    }
  });
}

// ---- Items -----------------------------------------------------------------

async function makeItem(part, group, assets) {
  const inner = new THREE.Group();
  if (part.procedural) {
    // Built flat with the long side along Z already.
    inner.add(part.objects[0]);
    if (group.lay === 'x') inner.rotation.y = Math.PI / 2;
  } else {
    const rep = part.objects[0];
    const pts = worldPoints(rep);
    const q = flatRotation(pts, group.lay || 'z', group.up, group.keepYaw);
    const clone = rep.clone(true);
    clone.matrixAutoUpdate = false;
    clone.matrix.copy(rep.matrixWorld);
    if (group.finish !== 'original') applyFinish(clone, group.finish || 'glb', group.color, group.material);
    else {
      const recolor = Object.entries(group.recolor || {}).map(([re, col]) => [new RegExp(re), col]);
      clone.traverse((m) => {
        if (!m.isMesh) return;
        m.castShadow = true;
        m.receiveShadow = true;
        const hit = recolor.find(([re]) => re.test(m.name) || re.test(m.parent?.name || ''));
        const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((mat) => {
          const c = mat.clone();
          if (hit) c.color.set(hit[1]);
          else if (c.color) c.color.convertSRGBToLinear();
          return c;
        });
        m.material = Array.isArray(m.material) ? mats : mats[0];
      });
    }
    inner.add(clone);
    inner.quaternion.copy(q);
  }
  if (group.spin) inner.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), (group.spin * Math.PI) / 180);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner, true);
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const holder = new THREE.Group();
  holder.add(inner);
  const size = box.getSize(new THREE.Vector3());
  if (group.finish === 'carbon') carbonize(holder);
  else if (group.edges) {
    const ms = [];
    holder.traverse((m) => m.isMesh && ms.push(m));
    outline(ms, group.edges.color, group.edges.opacity);
  }
  if (group.decal) await applyDecal(holder, group.decal, assets, size);
  return {holder, w: size.x, d: size.z, h: size.y};
}

// A block is the shown copies of one unique part, side by side along X and
// wrapped every perRow copies.
async function makeBlock(part, group, gap, assets) {
  const count = (part.countOverride ?? part.objects.length) + (group.extra ?? 0);
  const show = group.show === 'all' || group.show === undefined ? count : Math.min(count, group.show);
  const item = await makeItem(part, group, assets);
  const perRow = Math.max(1, Math.min(show, group.perRow || show));
  const rows = Math.ceil(show / perRow);
  const g = group.copyGap !== undefined ? group.copyGap / 1000 : gap * 0.6;
  const root = new THREE.Group();
  for (let i = 0; i < show; i++) {
    const r = Math.floor(i / perRow);
    const cIdx = i % perRow;
    const inRow = Math.min(perRow, show - r * perRow);
    const rowW = inRow * item.w + (inRow - 1) * g;
    const copy = i === 0 ? item.holder : item.holder.clone(true);
    copy.position.set(-rowW / 2 + item.w / 2 + cIdx * (item.w + g), 0, -((rows - 1) * (item.d + g)) / 2 + r * (item.d + g));
    root.add(copy);
  }
  const bw = perRow * item.w + (perRow - 1) * g;
  const bd = rows * item.d + (rows - 1) * g;
  return {
    root,
    w: bw,
    d: bd,
    h: item.h,
    area: item.w * item.d,
    name: part.name,
    label: group.label || part.name,
    count,
    show,
    section: group.section || 'parts',
    row: group.row,
  };
}

function joinBlocks(bs, g) {
  const root = new THREE.Group();
  const w = bs.reduce((s, b) => s + b.w, 0) + g * (bs.length - 1);
  let x = -w / 2;
  for (const b of bs) {
    b.root.position.x += x + b.w / 2;
    root.add(b.root);
    x += b.w + g;
  }
  return {...bs[0], root, w, d: Math.max(...bs.map((b) => b.d)), h: Math.max(...bs.map((b) => b.h)),
    area: bs.reduce((s, b) => s + b.area, 0), label: bs[0].label,
    count: bs.reduce((s, b) => s + b.count, 0), show: bs.reduce((s, b) => s + b.show, 0)};
}

// Layout. Groups with a "row" number go to that row (spec order within the
// row); the rest are shelf-packed after them, largest first, into rows no
// wider than the widest manual row. Every row is centred and justified: its
// spare width is spread over its gaps, up to 3x the base gap.
function layout(blocks, opts) {
  const {gap, sectionGap, aspect} = opts;
  const manual = new Map();
  const auto = [];
  for (const b of blocks) {
    if (b.row === undefined) auto.push(b);
    else {
      if (!manual.has(b.row)) manual.set(b.row, []);
      manual.get(b.row).push(b);
    }
  }
  const gapOf = (b) => (b.section === 'hardware' ? gap * 0.8 : gap);
  const rowW = (items) => items.reduce((s, b, i) => s + b.w + (i ? gapOf(b) : 0), 0);
  const rows = [...manual.keys()].sort((x, y) => x - y).map((k) => manual.get(k));
  auto.sort((x, y) => (x.section === 'hardware') - (y.section === 'hardware') || y.w * y.d - x.w * x.d);
  let W = rows.length ? Math.max(...rows.map(rowW)) : 0;
  if (!W) {
    // No manual rows: pick the width whose packing is closest to the aspect.
    const total = auto.reduce((t, b) => t + b.w + gap, 0);
    const minW = Math.max(...auto.map((b) => b.w));
    let best = null;
    for (let i = 0; i <= 100; i++) {
      const w = minW + ((total - minW) * i) / 100;
      const r = shelf(auto, w, gapOf, rowW);
      const d = r.reduce((t, x) => t + Math.max(...x.map((b) => b.d)) + gap, 0);
      const score = Math.abs(Math.log(w / d / aspect));
      if (!best || score < best.score) best = {w, score};
    }
    W = best.w;
  }
  W = Math.max(W, ...auto.map((b) => b.w));
  rows.push(...shelf(auto, W, gapOf, rowW));

  const placed = [];
  let z = 0;
  rows.forEach((items, i) => {
    const d = Math.max(...items.map((b) => b.d));
    if (i > 0) {
      const prev = rows[i - 1];
      const newSection = prev[0].section !== items[0].section;
      z += newSection ? sectionGap : Math.max(gapOf(items[0]), gapOf(prev[0]));
    }
    const base = rowW(items);
    const extra = items.length > 1 ? Math.min((W - base) / (items.length - 1), gapOf(items[0]) * 3) : 0;
    const width = base + extra * (items.length - 1);
    let x = -width / 2;
    items.forEach((b, j) => {
      if (j) x += gapOf(b) + extra;
      // Hardware rows share a back edge; part rows are centred.
      placed.push({b, x: x + b.w / 2, z: b.section === 'hardware' ? z + b.d / 2 : z + d / 2});
      x += b.w;
    });
    z += d;
  });
  return {placed, W, D: z, rows: rows.length};
}

function shelf(blocks, W, gapOf, rowW) {
  const rows = [];
  let row = null;
  for (const b of blocks) {
    if (!row || row[0].section !== b.section || rowW([...row, b]) > W + 1e-9) {
      row = [];
      rows.push(row);
    }
    row.push(b);
  }
  return rows;
}

// ---- Scene + render ----------------------------------------------------------

function buildRenderer(wPx, hPx) {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, preserveDrawingBuffer: true});
  renderer.setPixelRatio(1);
  renderer.setSize(wPx, hPx, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

function downsample(src, width, height, labels) {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, width, height);
  if (labels) {
    ctx.font = '600 22px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const l of labels) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(l.text, l.x * width, l.y * height + 6);
    }
  }
  return out.toDataURL('image/png');
}

// A selector is a name regex, optionally narrowed to GLB mesh indices and a
// source index; used by groups and excludes alike.
function selector(sel) {
  const s = typeof sel === 'string' ? {match: sel} : sel;
  const re = new RegExp(s.match, 'i');
  return (p) =>
    re.test(p.name) &&
    (s.meshes === undefined || s.meshes.includes(p.mesh)) &&
    (s.source === undefined || s.source === p.source);
}

// Several parts that form one physical item (a screw exported as separate
// head and shank bodies) are merged, keeping their relative placement.
// From parts with several instances (four motors), take the instance of
// each part nearest the first one, so one physical item is assembled.
// combine: "all" takes every instance (a whole board).
function combineParts(parts, mode) {
  const wrap = new THREE.Group();
  const centre = (o) => new THREE.Box3().setFromObject(o, true).getCenter(new THREE.Vector3());
  const anchor = centre(parts[0].objects[0]);
  const add = (obj) => {
    const c = obj.clone(true);
    c.matrixAutoUpdate = false;
    c.matrix.copy(obj.matrixWorld);
    wrap.add(c);
  };
  for (const p of parts) {
    if (mode === 'all') p.objects.forEach(add);
    else add(p.objects.reduce((best, o) => (centre(o).distanceTo(anchor) < centre(best).distanceTo(anchor) ? o : best)));
  }
  wrap.updateMatrixWorld(true);
  return {name: parts.map((p) => p.name).join(' + '), mesh: parts.map((p) => p.mesh), source: parts[0].source,
    objects: [wrap]};
}

async function render(job) {
  const parts = await loadAll(job.sources);
  const assets = job.assets || {};
  const matCtx = {assets, material: (finish, color, extra) => finishMaterial(finish, null, color, extra)};
  const groups = job.groups.map((g) => ({...g, test: g.procedural ? () => false : selector(g)}));
  const excludes = (job.exclude || []).map(selector);
  const report = {included: [], excluded: [], unmatched: []};
  const blocks = [];
  const gap = (job.layout?.gapMm ?? 8) / 1000;
  const members = new Map(groups.map((g) => [g, []]));
  for (const part of parts) {
    const hits = groups.filter((g) => g.test(part));
    const ex = excludes.some((t) => t(part));
    const id = `${part.name} (source ${part.source}, mesh ${part.mesh})`;
    if (hits.length && ex) throw new Error(`part both included and excluded: ${id}`);
    if (hits.length > 1) throw new Error(`part matches ${hits.length} groups: ${id}`);
    if (ex) {
      report.excluded.push({name: part.name, source: part.source, mesh: part.mesh, count: part.objects.length});
    } else if (!hits.length) {
      report.unmatched.push({name: part.name, source: part.source, mesh: part.mesh, count: part.objects.length});
    } else members.get(hits[0]).push(part);
  }
  for (const [g, ps] of members) {
    let list;
    if (g.procedural) {
      const obj = await buildProcedural(g.procedural, matCtx);
      list = [{name: `${g.procedural.kind} (procedural)`, mesh: null, source: null, objects: [obj], procedural: true,
        countOverride: g.count ?? 1}];
    } else {
      if (!ps.length) throw new Error(`group matched nothing: ${g.label || g.match}`);
      list = g.combine ? [{...combineParts(ps, g.combine), countOverride: g.count}] : ps;
    }
    const own = [];
    for (const part of list) {
      const b = await makeBlock(part, g, gap, assets);
      own.push(b);
      report.included.push({name: part.name, source: part.source, mesh: part.mesh, group: g.label, count: b.count,
        shown: b.show, finish: g.finish, note: g.note});
    }
    // Members of one group (L/R boots, both base plates) stay together.
    const block = own.length > 1 ? joinBlocks(own, gap * 0.6) : own[0];
    block.on = g.on;
    blocks.push(block);
  }
  // A block with "on" lies centred on top of another (a board on its bag).
  for (const b of blocks.filter((x) => x.on)) {
    const host = blocks.find((x) => x.label === b.on && !x.on);
    if (!host) throw new Error(`"on" target not found: ${b.on}`);
    b.root.position.y += host.h;
    host.root.add(b.root);
  }
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].on) blocks.splice(i, 1);
  if (report.unmatched.length) return {report};

  const L = layout(blocks, {
    gap,
    sectionGap: (job.layout?.sectionGapMm ?? 14) / 1000,
    aspect: job.layout?.aspect ?? 1.6,
  });
  const scene = new THREE.Scene();
  const content = new THREE.Group();
  for (const p of L.placed) {
    p.b.root.position.set(p.x, 0, p.z - L.D / 2);
    content.add(p.b.root);
  }
  scene.add(content);
  content.updateMatrixWorld(true);

  // Lighting: soft room environment for reflections, one shadowing key.
  const renderer0 = buildRenderer(16, 16);
  const pmrem = new THREE.PMREMGenerator(renderer0);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const span = Math.max(L.W, L.D);
  const key = new THREE.DirectionalLight(0xffffff, job.light?.key ?? 3.0);
  key.position.set(-0.35 * span, 1.6 * span, -0.9 * span);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.radius = 6;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.0004;
  const sc = key.shadow.camera;
  sc.left = -span;
  sc.right = span;
  sc.top = span;
  sc.bottom = -span;
  sc.near = 0.01;
  sc.far = span * 5;
  scene.add(key);
  scene.add(key.target);
  const fill = new THREE.DirectionalLight(0xdfe8ff, job.light?.fill ?? 0.6);
  fill.position.set(0.8 * span, 0.9 * span, 0.7 * span);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x222222, 0.35));

  const shadowMat = new THREE.ShadowMaterial({opacity: 0.22});
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 6, span * 6), shadowMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.00002;
  ground.receiveShadow = true;
  scene.add(ground);

  // Camera: orthographic, straight down or tilted toward the viewer.
  const tilt = ((job.camera?.tiltDeg ?? 0) * Math.PI) / 180;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, span * 20);
  const dist = span * 4;
  cam.position.set(0, Math.cos(tilt) * dist, Math.sin(tilt) * dist);
  cam.up.set(0, 0, -1);
  if (tilt > 0) cam.up.set(0, 1, 0);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  // Fit to the projected bounds of every item.
  const inv = cam.matrixWorldInverse;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const v = new THREE.Vector3();
  content.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).applyMatrix4(inv);
      x0 = Math.min(x0, v.x);
      x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y);
      y1 = Math.max(y1, v.y);
    }
  });
  // A lone small item (one motor) is framed in at least minSpanMm so it
  // reads as an object on a table, not a macro close-up.
  const minSpan = (job.layout?.minSpanMm ?? 0) / 1000;
  for (const [lo, hi] of [['x0', 'x1'], ['y0', 'y1']]) {
    const b = {x0, x1, y0, y1};
    const grow = Math.max(0, minSpan - (b[hi] - b[lo])) / 2;
    if (lo === 'x0') {
      x0 -= grow;
      x1 += grow;
    } else {
      y0 -= grow;
      y1 += grow;
    }
  }
  const margin = (job.layout?.marginFrac ?? 0.05) * Math.max(x1 - x0, y1 - y0);
  cam.left = x0 - margin;
  cam.right = x1 + margin;
  cam.top = y1 + margin;
  cam.bottom = y0 - margin;
  cam.updateProjectionMatrix();

  const width = job.width || 2400;
  const height = Math.round((width * (cam.top - cam.bottom)) / (cam.right - cam.left));
  const ss = job.supersample || 2;
  const renderer = buildRenderer(width * ss, height * ss);
  scene.environment = envTex;
  scene.environmentIntensity = job.light?.env ?? 1.0;

  const labels = L.placed.map((p) => {
    const c = new THREE.Vector3(p.x, 0, p.z - L.D / 2 + p.b.d / 2).project(cam);
    return {text: `${p.b.count > 1 ? `×${p.b.count} ` : ''}${p.b.label}`, x: (c.x + 1) / 2, y: (1 - c.y) / 2};
  });

  const out = {report, width, height, rows: L.rows, layoutMm: [L.W * 1000, L.D * 1000],
    pxPerMm: width / ((cam.right - cam.left) * 1000)};
  renderer.render(scene, cam);
  out.transparent = downsample(renderer.domElement, width, height, null);
  scene.background = new THREE.Color(job.darkBackground || '#0d0f12');
  shadowMat.opacity = 0.5;
  renderer.render(scene, cam);
  out.dark = downsample(renderer.domElement, width, height, null);
  out.debug = downsample(renderer.domElement, width, height, labels);
  return out;
}

async function probe(sources) {
  const parts = await loadAll(sources);
  return parts.map((p) => {
    const box = new THREE.Box3().setFromObject(p.objects[0], true);
    const s = box.getSize(new THREE.Vector3()).multiplyScalar(1000);
    const c = box.getCenter(new THREE.Vector3()).multiplyScalar(1000);
    return {name: p.name, source: p.source, mesh: p.mesh, count: p.objects.length,
      sizeMm: [s.x, s.y, s.z].map((x) => +x.toFixed(1)), centerMm: [c.x, c.y, c.z].map((x) => +x.toFixed(1))};
  });
}

window.inTheBox = {render, probe};
window.inTheBoxReady = true;
