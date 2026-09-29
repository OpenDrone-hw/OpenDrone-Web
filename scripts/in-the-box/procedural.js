// Procedurally modelled box items that have no CAD: straps, washers, cards,
// wires, connectors, capacitors, grommets, antennas, bags. Every builder
// works in millimetres and returns a THREE.Group scaled to metres, lying on
// y = 0 with Y up and its long axis along Z, at true size. Dimensions are
// nominal catalogue values, stated beside each builder.
import * as THREE from 'three';

const MM = 0.001;

function wrap(...children) {
  const inner = new THREE.Group();
  for (const c of children) inner.add(c);
  inner.scale.setScalar(MM);
  const g = new THREE.Group();
  g.add(inner);
  g.traverse((m) => {
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
    }
  });
  return g;
}

function mesh(geo, mat) {
  return new THREE.Mesh(geo, mat);
}

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// Planar top-down UVs normalised to the geometry's footprint, so a canvas
// drawn at the footprint's aspect maps 1:1 onto the top face.
export function footprintUv(geo, flipV = false) {
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  const pos = geo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - b.min.x) / (b.max.x - b.min.x);
    const v = (pos.getZ(i) - b.min.z) / (b.max.z - b.min.z);
    uv[i * 2 + 1] = flipV ? v : 1 - v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}


// ---- Artwork ---------------------------------------------------------------

async function svgImage(svgText) {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  await img.decode();
  return img;
}

// Draws svg artwork into ctx at (x, y, w, h), optionally recoloured flat.
export async function drawArt(ctx, svgText, x, y, w, h, color) {
  const img = await svgImage(svgText);
  const scale = Math.min(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  const off = document.createElement('canvas');
  off.width = Math.ceil(dw);
  off.height = Math.ceil(dh);
  const o = off.getContext('2d');
  o.drawImage(img, 0, 0, dw, dh);
  if (color) {
    o.globalCompositeOperation = 'source-in';
    o.fillStyle = color;
    o.fillRect(0, 0, off.width, off.height);
  }
  ctx.drawImage(off, x + (w - dw) / 2, y + (h - dh) / 2);
}

const PX_PER_MM = 16;
function sheetCanvas(wMm, hMm) {
  const c = document.createElement('canvas');
  c.width = Math.round(wMm * PX_PER_MM);
  c.height = Math.round(hMm * PX_PER_MM);
  return c;
}

// A material the Blender stage rebuilds from its finish name; `tex` names
// textures registered with ctx.tex (colour, height, roughness and masks).
function tagged(finish, tex = {}, extra = {}) {
  const m = new THREE.MeshStandardMaterial({color: '#808080'});
  m.userData = {finish, tex, ...extra};
  return m;
}

// Top-down silhouette of CAD parts (the assembled frame) as a line drawing:
// fill every triangle, then keep only a thin rim (fill minus its erosion).
function silhouette(objects, size, color, lineW) {
  const pts = [];
  const v = new THREE.Vector3();
  const tris = [];
  for (const o of objects) {
    o.updateMatrixWorld(true);
    o.traverse((m) => {
      if (!m.isMesh) return;
      const pos = m.geometry.attributes.position;
      const idx = m.geometry.index;
      const at = (i) => v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone();
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const t = [0, 1, 2].map((k) => at(idx ? idx.getX(i + k) : i + k));
        tris.push(t);
        pts.push(...t);
      }
    });
  }
  const b = new THREE.Box3().setFromPoints(pts);
  const s = size / Math.max(b.max.x - b.min.x, b.max.y - b.min.y);
  const c = document.createElement('canvas');
  c.width = Math.ceil((b.max.x - b.min.x) * s) + 8;
  c.height = Math.ceil((b.max.y - b.min.y) * s) + 8;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  for (const t of tris) {
    g.beginPath();
    t.forEach((p, i) => {
      const x = (p.x - b.min.x) * s + 4;
      const y = (b.max.y - p.y) * s + 4;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.closePath();
    g.fill();
  }
  const er = document.createElement('canvas');
  er.width = c.width;
  er.height = c.height;
  const e = er.getContext('2d');
  e.drawImage(c, 0, 0);
  e.globalCompositeOperation = 'destination-in';
  for (let a = 0; a < 16; a++) {
    e.drawImage(c, Math.cos((a * Math.PI) / 8) * lineW, Math.sin((a * Math.PI) / 8) * lineW);
  }
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(er, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

// ---- Builders --------------------------------------------------------------

// Printed card, `w` x `h` mm on 0.35 mm board, 3 mm corners: matte black
// stock, gold-foil wordmark, a white line drawing of the frame from its CAD
// silhouette (when `illustration` names the parts) and one caption line.
async function card(p, ctx) {
  const w = p.w ?? 85;
  const h = p.h ?? 55;
  const c = sheetCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#17171a';
  g.fillRect(0, 0, c.width, c.height);
  const foil = sheetCanvas(w, h);
  const f = foil.getContext('2d');
  f.fillStyle = '#000';
  f.fillRect(0, 0, foil.width, foil.height);
  const markW = c.width * 0.56;
  const markY = p.illustration ? c.height * 0.1 : c.height * 0.3;
  await drawArt(g, ctx.assets.opendrone, (c.width - markW) / 2, markY, markW, c.height * 0.12, '#ffb700');
  await drawArt(f, ctx.assets.opendrone, (c.width - markW) / 2, markY, markW, c.height * 0.12, '#fff');
  if (p.illustration) {
    const re = new RegExp(p.illustration, 'i');
    const objs = ctx.parts.filter((pt) => re.test(pt.name)).flatMap((pt) => pt.objects);
    const art = silhouette(objs, c.width * 0.7, 'rgba(236,236,232,0.85)', 1.6 * (PX_PER_MM / 16) * 2);
    const sc = Math.min((c.width * 0.72) / art.width, (c.height * 0.56) / art.height);
    g.drawImage(art, (c.width - art.width * sc) / 2, c.height * 0.27, art.width * sc, art.height * sc);
  }
  if (p.caption) {
    g.fillStyle = 'rgba(229,229,229,0.72)';
    g.font = `500 ${Math.round(Math.min(c.height * 0.034, c.width * 0.045))}px Helvetica, Arial, sans-serif`;
    g.textAlign = 'center';
    g.fillText(p.caption, c.width / 2, p.illustration ? c.height * 0.9 : c.height * 0.7);
  }
  const geo = footprintUv(new THREE.ExtrudeGeometry(roundedRect(w, h, 3), {depth: 0.35, bevelEnabled: false})
    .rotateX(Math.PI / 2).translate(0, 0.35, 0));
  return wrap(mesh(geo, tagged('paper', {color: ctx.tex('card', c), foil: ctx.tex('card-foil', foil)})));
}

// Die-cut vinyl sticker: gold wordmark on black with a thin white border.
async function sticker(p, ctx) {
  const w = (p.w ?? 80) + 3;
  const h = (p.h ?? 22) + 3;
  const c = sheetCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#f2f2ef';
  g.fillRect(0, 0, c.width, c.height);
  const in1 = 1.5 * PX_PER_MM;
  g.fillStyle = '#111113';
  g.beginPath();
  g.roundRect(in1, in1, c.width - 2 * in1, c.height - 2 * in1, (h - 3) * 0.22 * PX_PER_MM);
  g.fill();
  await drawArt(g, ctx.assets.opendrone, c.width * 0.1, c.height * 0.22, c.width * 0.8, c.height * 0.56, '#ffb700');
  const geo = footprintUv(new THREE.ExtrudeGeometry(roundedRect(w, h, h * 0.25), {depth: 0.2, bevelEnabled: false})
    .rotateX(Math.PI / 2).translate(0, 0.2, 0));
  return wrap(mesh(geo, tagged('vinyl', {color: ctx.tex('sticker', c)})));
}

// Static-shielding bag, after the real OpenDrone bag (sourcing IPN
// PKG-ESD-BAG-60X90-OD): 60 x 90 mm dark metallised film, semi-transparent,
// 12 mm heat-sealed header with a zip strip under it, 4 mm textured side and
// bottom seals, black OpenDrone wordmark, no caution mark. Two sheets: a
// flat back and a crinkled front that drapes over whatever lies inside
// (stage.js calls `bagFit` with the board size). Canvas row 0 is the header.
const BAG = {side: 4, bottom: 5, header: 12, zip: 15.5};

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function esdBag(p, ctx) {
  const w = p.w ?? 60;
  const h = p.h ?? 90;
  const P = PX_PER_MM;
  const mk = () => sheetCanvas(w, h);
  const col = mk();
  const alpha = mk();
  const hgt = mk();
  const ink = mk();
  const g = col.getContext('2d');
  const a = alpha.getContext('2d');
  const hh = hgt.getContext('2d');
  const k = ink.getContext('2d');
  const W = col.width;
  const H = col.height;
  g.fillStyle = '#a3a7ad';
  g.fillRect(0, 0, W, H);
  a.fillStyle = '#b4b4b4';
  a.fillRect(0, 0, W, H);
  // Thinner film over the contents so a small board still reads through it.
  const cy = (BAG.zip + 1.5 + (h - BAG.bottom - BAG.zip - 1.5) / 2) * P;
  const rg = a.createRadialGradient(W / 2, cy, 0, W / 2, cy, 24 * P);
  rg.addColorStop(0, '#5a5a5a');
  rg.addColorStop(1, '#b4b4b4');
  a.fillStyle = rg;
  a.fillRect(BAG.side * P, 0, W - 2 * BAG.side * P, H);
  hh.fillStyle = '#808080';
  hh.fillRect(0, 0, W, H);
  k.fillStyle = '#000';
  k.fillRect(0, 0, W, H);
  // Seal bands: two film layers fused, more opaque, with the sealing bar's
  // fine diamond knurl pressed in.
  const seals = [[0, 0, W, BAG.header * P], [0, 0, BAG.side * P, H], [W - BAG.side * P, 0, BAG.side * P, H],
    [0, H - BAG.bottom * P, W, BAG.bottom * P]];
  for (const [x, y, sw, sh] of seals) {
    g.fillStyle = '#80848a';
    g.fillRect(x, y, sw, sh);
    a.fillStyle = '#e2e2e2';
    a.fillRect(x, y, sw, sh);
    hh.save();
    hh.beginPath();
    hh.rect(x, y, sw, sh);
    hh.clip();
    const pitch = 0.9 * P;
    hh.lineWidth = 0.28 * P;
    for (const dir of [1, -1]) {
      hh.strokeStyle = dir > 0 ? '#a8a8a8' : '#5a5a5a';
      for (let t = -H; t < W + H; t += pitch) {
        hh.beginPath();
        hh.moveTo(t, 0);
        hh.lineTo(t + dir * H, H);
        hh.stroke();
      }
    }
    hh.restore();
  }
  // Zip strip: two moulded rails across the bag under the header.
  for (const dz of [-0.9, 0.9]) {
    const y = (BAG.zip + dz) * P;
    g.fillStyle = '#9ea2a8';
    g.fillRect(BAG.side * P, y - 0.45 * P, W - 2 * BAG.side * P, 0.9 * P);
    a.fillStyle = '#d8d8d8';
    a.fillRect(BAG.side * P, y - 0.5 * P, W - 2 * BAG.side * P, 1.0 * P);
  }
  // Tear notches in the header seal.
  for (const x of [0, W]) {
    a.fillStyle = '#000';
    a.beginPath();
    a.moveTo(x, 6 * P);
    a.lineTo(x + (x ? -1 : 1) * 1.6 * P, 7 * P);
    a.lineTo(x, 8 * P);
    a.fill();
  }
  // Black wordmark across the middle of the pocket.
  const ww = w * 0.74 * P;
  const wh = ww * 0.16;
  const wy = (BAG.zip + (h - BAG.zip - BAG.bottom) * 0.5) * P - wh / 2 - 13 * P;
  await drawArt(g, ctx.assets.opendrone, (W - ww) / 2, wy, ww, wh, '#0b0b0c');
  await drawArt(a, ctx.assets.opendrone, (W - ww) / 2, wy, ww, wh, '#ffffff');
  await drawArt(k, ctx.assets.opendrone, (W - ww) / 2, wy, ww, wh, '#ffffff');
  const id = `bag-${w}x${h}`;
  const texs = {color: ctx.tex(`${id}-c`, col), alpha: ctx.tex(`${id}-a`, alpha), height: ctx.tex(`${id}-h`, hgt),
    ink: ctx.tex(`${id}-k`, ink)};
  const film = tagged('bag', texs);
  const back = tagged('bag', {}, {alpha: 0.72});

  // Pocket (inside the seals) in bag coordinates: x across, z along, z = 0 at the header edge.
  const px0 = -w / 2 + BAG.side;
  const px1 = w / 2 - BAG.side;
  const pz0 = BAG.zip + 1.5;
  const pz1 = h - BAG.bottom;
  const rand = mulberry(p.seed ?? 7);
  // Folds: a few long soft undulations, mostly along the bag, plus a handful
  // of localised creases (Gaussian ridges on random short segments).
  const waves = Array.from({length: 5}, (_, i) => {
    const ang = Math.PI / 2 + (rand() - 0.5) * (i < 3 ? 0.5 : 2.0);
    return {dx: Math.cos(ang), dz: Math.sin(ang), f: (2 * Math.PI) / (18 + rand() * 26), ph: rand() * 6.28,
      amp: 0.12 + rand() * 0.16};
  });
  const creases = Array.from({length: 34}, () => {
    const ang = Math.PI / 2 + (rand() - 0.5) * 1.4;
    return {x: px0 + rand() * (px1 - px0), z: pz0 + rand() * (pz1 - pz0), dx: Math.cos(ang), dz: Math.sin(ang),
      L: 4 + rand() * 14, wdt: 0.6 + rand() * 1.6, amp: (rand() < 0.5 ? -1 : 1) * (0.14 + rand() * 0.24)};
  });
  const smooth = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const sheet = (content) => {
    const NX = 120;
    const NZ = 180;
    const pos = [];
    const uv = [];
    const idx = [];
    const [bw, bd, bh] = content ?? [0, 0, 0];
    const cz = (pz0 + pz1) / 2;
    for (let j = 0; j <= NZ; j++) {
      for (let i = 0; i <= NX; i++) {
        const x = -w / 2 + (w * i) / NX;
        const z = (h * j) / NZ;
        // 0 on the seals, 1 well inside the pocket.
        const inside = Math.min(smooth(px0, px0 + 5, x), smooth(-px1, -px1 + 5, -x), smooth(pz0, pz0 + 4, z),
          smooth(-pz1, -pz1 + 5, -z));
        let y = 0.22 + inside * 0.7;
        if (bw) {
          const dx = Math.max(0, Math.abs(x) - bw / 2);
          const dz = Math.max(0, Math.abs(z - cz) - bd / 2);
          const dist = Math.hypot(dx, dz);
          y = Math.max(y, (0.25 + bh) * (1 - smooth(0, 22, dist)) ** 1.5);
        }
        let crinkle = 0;
        for (const wv of waves) crinkle += wv.amp * Math.sin((x * wv.dx + z * wv.dz) * wv.f + wv.ph);
        for (const c of creases) {
          const ux = x - c.x;
          const uz = z - c.z;
          const along = ux * c.dx + uz * c.dz;
          const across = -ux * c.dz + uz * c.dx;
          crinkle += c.amp * Math.exp(-((across / c.wdt) ** 2)) * Math.exp(-((along / c.L) ** 4));
        }
        y += crinkle * (0.25 + 0.75 * inside);
        for (const dz of [-0.9, 0.9]) y += 0.35 * Math.exp(-(((z - BAG.zip - dz) / 0.45) ** 2)) * (1 - inside);
        pos.push(x, y, z - h / 2);
        uv.push(i / NX, 1 - j / NZ);
      }
    }
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const q = j * (NX + 1) + i;
        idx.push(q, q + NX + 1, q + 1, q + 1, q + NX + 1, q + NX + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  };
  const backGeo = new THREE.BoxGeometry(w - 0.4, 0.08, h - 0.4).translate(0, 0.04, 0);
  const front = mesh(sheet(null), film);
  const out = wrap(mesh(backGeo, back), front);
  // Board inside: rebuild the front over it; returns where the board goes.
  out.userData.bagFit = (bwMm, bdMm, bhMm) => {
    front.geometry.dispose();
    front.geometry = sheet([bwMm, bdMm, bhMm]);
    return {y: 0.1 * MM, z: ((pz0 + pz1) / 2 - h / 2) * MM};
  };
  return out;
}

// Battery strap, after the shipped strap: `w` x `len` mm charcoal woven
// webbing with a dense rubberised cross-weave grip on the face, a chromed
// rectangular wire loop at the buckle end (webbing folded through it) and a
// black hook-and-loop patch over the rounded tip carrying one wordmark along
// the strap: "Open" white, "Drone" gold. Lies flat.
let strapN = 0;
async function strap(p, ctx) {
  const w = p.w ?? 20;
  const len = p.len ?? 220;
  const t = 1.3;
  const id = `strap-${w}x${len}-${strapN++}`;
  const PX = 10;
  const cw = Math.round(w * PX);
  const ch = Math.round(len * PX);
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    return c;
  };
  const col = mk();
  const hgt = mk();
  const rgh = mk();
  const g = col.getContext('2d');
  const hh = hgt.getContext('2d');
  const r = rgh.getContext('2d');
  g.fillStyle = '#25282e';
  g.fillRect(0, 0, cw, ch);
  hh.fillStyle = '#585858';
  hh.fillRect(0, 0, cw, ch);
  r.fillStyle = '#c0c0c0';
  r.fillRect(0, 0, cw, ch);
  // Rubberised grip: a dense waffle grid of small raised rubber nubs
  // (1.3 mm across the strap, 0.9 mm along it), lighter than the woven
  // ground between them, soft and slightly fuzzy.
  const px = 1.3 * PX;
  const py = 0.9 * PX;
  for (let y = 0; y < ch; y += py) {
    for (let x = 0; x < cw; x += px) {
      const jx = (Math.random() - 0.5) * 1.2;
      const jy = (Math.random() - 0.5) * 1.2;
      const tone = 0.85 + Math.random() * 0.3;
      g.fillStyle = `rgb(${Math.round(72 * tone)},${Math.round(77 * tone)},${Math.round(86 * tone)})`;
      g.fillRect(x + 2 + jx, y + 1.5 + jy, px - 4, py - 3);
      hh.fillStyle = '#d4d4d4';
      hh.fillRect(x + 2 + jx, y + 1.5 + jy, px - 4, py - 3);
      r.fillStyle = '#a0a0a0';
      r.fillRect(x + 2 + jx, y + 1.5 + jy, px - 4, py - 3);
    }
  }
  // Selvedges: a slightly darker, tighter edge band.
  for (const x of [0, cw - 0.9 * PX]) {
    g.fillStyle = '#23262c';
    g.fillRect(x, 0, 0.9 * PX, ch);
    hh.fillStyle = '#909090';
    hh.fillRect(x, 0, 0.9 * PX, ch);
    r.fillStyle = '#d0d0d0';
    r.fillRect(x, 0, 0.9 * PX, ch);
  }
  // Smooth black fabric patch over the rounded tip, 1.9 strap widths long
  // (canvas row 0 is the tip end).
  const patch = Math.min(1.9 * w, len * 0.3) * PX;
  g.fillStyle = '#0e0f12';
  g.fillRect(0, 0, cw, patch);
  hh.fillStyle = '#808080';
  hh.fillRect(0, 0, cw, patch);
  r.fillStyle = '#9c9c9c';
  r.fillRect(0, 0, cw, patch);
  // Sewn border of the patch.
  for (const [x1, y1, x2, y2] of [[0.7, patch - 0.9 * PX, w - 0.7, patch - 0.9 * PX]]) {
    g.strokeStyle = '#2a2c31';
    g.lineWidth = 0.35 * PX;
    g.setLineDash([1.4 * PX, 0.6 * PX]);
    g.beginPath();
    g.moveTo(x1 * PX, y1);
    g.lineTo(x2 * PX, y2);
    g.stroke();
    g.setLineDash([]);
  }
  // One wordmark, rotated 90 degrees clockwise so it reads down the strap
  // from the buckle towards the tip: white "Open", brand gold "Drone".
  const tw = patch * 0.93;
  const th = Math.min(cw * 0.7, tw * 0.34);
  const split = 0.445;
  for (const [x0, x1, colr] of [[0, split, '#f4f2ec'], [split, 1, '#ffb700']]) {
    g.save();
    g.translate(cw / 2, patch / 2);
    g.rotate(-Math.PI / 2);
    g.beginPath();
    g.rect(-tw / 2 + tw * x0, -th, tw * (x1 - x0), th * 2);
    g.clip();
    await drawArt(g, ctx.assets.opendrone, -tw / 2, -th / 2, tw, th, colr);
    g.restore();
  }
  const N = 200;
  const pos = [];
  const uv = [];
  const idx = [];
  const halfW = (z) => {
    const tip = len - z;
    return tip < w / 2 ? Math.sqrt(Math.max(0, (w / 2) ** 2 - (w / 2 - tip) ** 2)) : w / 2;
  };
  // A slight natural sideways sweep, no lift.
  const sway = (z) => 0.8 * Math.sin((z / len) * Math.PI);
  for (let i = 0; i <= N; i++) {
    const z = (len * i) / N;
    const hw = Math.max(0.3, halfW(z));
    for (const yy of [t, 0]) {
      for (const sx of [-1, 1]) {
        pos.push(sx * hw + sway(z), yy, z - len / 2);
        uv.push(0.5 - (sx * hw) / w, z / len);
      }
    }
  }
  const row = 4;
  for (let i = 0; i < N; i++) {
    const a = i * row;
    const b = (i + 1) * row;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  for (let i = 0; i < N; i++) {
    const a = i * row;
    const b = (i + 1) * row;
    idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
    idx.push(a, a + 2, b, a + 2, b + 2, b);
    idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.addGroup(0, N * 6, 0);
  geo.addGroup(N * 6, N * 18, 1);
  geo.computeVertexNormals();
  const texs = {color: ctx.tex(`${id}-c`, col), height: ctx.tex(`${id}-h`, hgt), rough: ctx.tex(`${id}-r`, rgh)};
  const web = mesh(geo, [tagged('webbing', texs), tagged('webbing', {height: texs.height})]);
  // Polished silver rectangular wire loop, wider than the strap, at the
  // buckle end: the webbing is folded back through it (pale underside inside
  // the opening) and sewn, so the ring lies flat at the very end.
  const wire = 0.75;
  const ow = w * 1.25;
  const od2 = w * 0.8;
  const hx = ow / 2 - wire;
  const hz = od2 / 2 - wire;
  const rc = 2.2;
  const ringPath = new THREE.CurvePath();
  const P = (x, z) => new THREE.Vector3(x, 0, z);
  const cor = [[hx, -hz], [hx, hz], [-hx, hz], [-hx, -hz]];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = cor[i];
    const [x1, z1] = cor[(i + 1) % 4];
    const [x2, z2] = cor[(i + 2) % 4];
    const d1 = new THREE.Vector3(x1 - x0, 0, z1 - z0).normalize();
    const d2 = new THREE.Vector3(x2 - x1, 0, z2 - z1).normalize();
    const pA = P(x0, z0).addScaledVector(d1, i ? rc : rc);
    const pB = P(x1, z1).addScaledVector(d1, -rc);
    const pC = P(x1, z1).addScaledVector(d2, rc);
    ringPath.add(new THREE.LineCurve3(pA, pB));
    ringPath.add(new THREE.QuadraticBezierCurve3(pB, P(x1, z1), pC));
  }
  const ringPts = ringPath.getSpacedPoints(200);
  const ringGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ringPts, true), 260, wire, 14, true);
  const ring = mesh(ringGeo, tagged('chrome', {}, {color: '#eceef1'}));
  const zRing = -len / 2 - hz + 2.2 * wire;
  ring.position.set(0, wire, zRing);
  // Folded-back webbing end inside the ring: pale, thin, lying on the table.
  const flapLen = 2 * hz + 0.5;
  const flap = mesh(new THREE.BoxGeometry(w - 0.6, 0.8, flapLen), tagged('webbing', {}, {color: '#b3b0a8'}));
  flap.position.set(0, 0.4, zRing - hz + flapLen / 2 - 0.2);
  return wrap(web, ring, flap);
}

// M3 aluminium cup washer: 9 mm OD, 2.5 mm tall, 3.2 mm bore, conical cup.
function cupWasher(p, ctx) {
  const od = p.od ?? 9;
  const h = p.h ?? 2.5;
  const bore = (p.bore ?? 3.2) / 2;
  const r = od / 2;
  const prof = [
    [bore, 0],
    [r * 0.62, 0],
    [r, h * 0.72],
    [r, h],
    [r * 0.86, h],
    [bore + 0.35, h * 0.34],
    [bore, h * 0.34],
    [bore, 0],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const geo = new THREE.LatheGeometry(prof, 48);
  return wrap(mesh(geo, ctx.material('alu', p.color ?? '#1d1e21', {roughness: 0.42})));
}

// Silicone soft-mount grommet lying on its side. M2: 5 mm flange, 3.4 mm
// waist, 4.5 mm long, 2 mm bore. M3: 6.5 / 4.6 / 5.5 / 3 mm.
function grommet(p, ctx) {
  const m3 = p.size === 'M3';
  const R = m3 ? 3.25 : 2.5;
  const rw = m3 ? 2.3 : 1.7;
  const L = m3 ? 5.5 : 4.5;
  const fl = m3 ? 1.4 : 1.1;
  const bore = m3 ? 1.5 : 1.0;
  const prof = [
    [bore, 0],
    [R, 0],
    [R, fl],
    [rw, fl + 0.3],
    [rw, L - fl - 0.3],
    [R, L - fl],
    [R, L],
    [bore, L],
    [bore, 0],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const geo = new THREE.LatheGeometry(prof, 40);
  geo.rotateZ(Math.PI / 2); // axis along X
  geo.translate(L / 2, R, 0);
  return wrap(mesh(geo, ctx.material('rubber', p.color ?? '#3a3c41')));
}

// Silicone wire along a gentle curve in the XZ plane, stripped and tinned
// `strip` mm at both ends (or only the far end when `oneEnd`).
function wire(points, od, color, strip, core, oneEnd, ctx) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, od / 2, z)));
  const total = curve.getLength();
  const parts = [];
  const insStart = oneEnd ? 0 : strip / total;
  const insEnd = 1 - strip / total;
  const sub = (a, b) => new THREE.CatmullRomCurve3(
    Array.from({length: 24}, (_, i) => curve.getPointAt(a + ((b - a) * i) / 23)),
  );
  parts.push(mesh(new THREE.TubeGeometry(sub(insStart, insEnd), 96, od / 2, 16, false),
    ctx.material('silicone', color)));
  const tin = ctx.material('zinc', '#c9ccd0');
  const tip = (a, b) => {
    const t = mesh(new THREE.TubeGeometry(sub(a, b), 8, core / 2, 10, false), tin);
    t.position.y = -(od - core) / 2;
    return t;
  };
  parts.push(tip(insEnd, 1));
  if (!oneEnd) parts.push(tip(0, insStart));
  // End caps on the insulation.
  return parts;
}

const AWG = {
  12: {od: 4.2, core: 2.05},
  16: {od: 2.9, core: 1.29},
  28: {od: 0.9, core: 0.32},
  30: {od: 0.75, core: 0.25},
};
const WIRE_COLOURS = {red: '#c42a22', black: '#17181b', yellow: '#e2b400', white: '#e6e6e2', blue: '#2a64c8',
  green: '#2f9a4b', orange: '#e0701f'};

// A loose set of hook-up wires, e.g. the 28 AWG four-colour set: each lies
// straight with one slight bow (at most 2 percent of its length).
function wireSet(p, ctx) {
  const {od, core} = AWG[p.awg ?? 28];
  const len = p.len ?? 100;
  const colors = p.colors ?? ['red', 'black', 'yellow', 'white'];
  const pitch = od + (p.spacing ?? 2.2);
  const rand = mulberry(p.seed ?? 3);
  const parts = [];
  colors.forEach((col, i) => {
    const x0 = (i - (colors.length - 1) / 2) * pitch;
    const amp = len * 0.02 * (0.6 + 0.4 * rand());
    const pts = [];
    for (let k = 0; k <= 8; k++) {
      const z = -len / 2 + (len * k) / 8;
      pts.push([x0 + amp * Math.sin((Math.PI * k) / 8), z]);
    }
    parts.push(...wire(pts, od, WIRE_COLOURS[col] ?? col, 3, core, false, ctx));
  });
  return wrap(...parts);
}

// XT30 / XT60 ESC-side connector with its two 100 mm silicone leads.
// XT60 body 15.6 x 8.2 x 16 mm, XT30 10.2 x 5.2 x 13 mm, nylon yellow.
function xtPigtail(p, ctx) {
  const xt60 = p.type === 'xt60';
  const bw = xt60 ? 15.6 : 10.2;
  const bh = xt60 ? 8.2 : 5.2;
  const bl = xt60 ? 16 : 13;
  const pitch = xt60 ? 7.2 : 5;
  const {od, core} = AWG[p.awg ?? (xt60 ? 12 : 16)];
  const len = p.len ?? 100;
  const yellow = ctx.material('nylon', '#f0b90b');
  // D profile: one long edge chamfered at both corners (the keying).
  const ch = bh * 0.3;
  const prof = new THREE.Shape();
  prof.moveTo(-bw / 2, 0);
  prof.lineTo(bw / 2, 0);
  prof.lineTo(bw / 2, bh - ch);
  prof.lineTo(bw / 2 - ch, bh);
  prof.lineTo(-bw / 2 + ch, bh);
  prof.lineTo(-bw / 2, bh - ch);
  prof.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(prof, {depth: bl, bevelEnabled: true, bevelSize: 0.3, bevelThickness: 0.3, bevelSegments: 2});
  bodyGeo.translate(0, 0.3, -bl);
  const body = mesh(bodyGeo, yellow);
  // Grip ribs on the top face.
  const parts = [body];
  for (let i = 0; i < 3; i++) {
    const rib = mesh(new THREE.BoxGeometry(bw * 0.5, 0.5, 0.7), yellow);
    rib.position.set(0, bh + 0.5, -bl + 2.2 + i * 1.6);
    parts.push(rib);
  }
  // Gold solder cups out of the back, leads soldered in.
  const gold = ctx.material('gold', '#d9a531');
  [-1, 1].forEach((s, i) => {
    const cup = mesh(new THREE.CylinderGeometry(od / 2 + 0.25, od / 2 + 0.25, 4.5, 20), gold);
    cup.rotation.x = Math.PI / 2;
    cup.position.set((s * pitch) / 2, bh / 2 + 0.3, 2);
    parts.push(cup);
    if (p.leads === false) return;
    const x0 = (s * pitch) / 2;
    const x1 = s * (pitch / 2 + 2.5);
    parts.push(...wire(Array.from({length: 9}, (_, k) => [x0 + (x1 - x0) * (k / 8) + 0.015 * len * Math.sin((Math.PI * k) / 8), 4 + (len * k) / 8]), od, i ? WIRE_COLOURS.red : WIRE_COLOURS.black, 6, core, true, ctx)
      .map((m) => {
        m.position.y += bh / 2 + 0.3 - od / 2;
        return m;
      }));
  });
  // Mating face: dark shroud opening with the two gold contacts in it.
  const shroud = mesh(new THREE.BoxGeometry(bw - 2.2, bh - 1.8, 0.4), ctx.material('plastic', '#2a2418'));
  shroud.position.set(0, bh / 2 + 0.3, -bl - 0.12);
  parts.push(shroud);
  const pinR = xt60 ? 1.75 : 1.0;
  for (const s of [-1, 1]) {
    const pin = mesh(new THREE.CylinderGeometry(pinR, pinR, 0.6, 24), gold);
    pin.rotation.x = Math.PI / 2;
    pin.position.set((s * pitch) / 2, bh / 2 + 0.3, -bl - 0.2);
    parts.push(pin);
  }
  return wrap(...parts);
}

// Low-ESR radial electrolytic capacitor lying on its side, black sleeve
// with the grey polarity band, leads `lead` mm. 470 uF 35 V: 10 x 20 mm;
// 470 uF 50 V: 12.5 x 20 mm.
function capacitor(p, ctx) {
  const d = p.d ?? 10;
  const l = p.l ?? 20;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#16171a';
  g.fillRect(0, 0, 512, 256);
  g.fillStyle = '#8d9096';
  g.fillRect(0, 0, 90, 256);
  g.fillStyle = '#16171a';
  g.font = 'bold 44px Helvetica, Arial, sans-serif';
  for (let y = 40; y < 256; y += 70) g.fillRect(30, y, 30, 8);
  g.save();
  g.translate(300, 128);
  g.rotate(Math.PI / 2);
  g.fillStyle = '#a6a9ae';
  g.textAlign = 'center';
  g.fillText(p.label ?? '470µF 35V', 0, 14);
  g.restore();
  const sleeve = mesh(new THREE.CylinderGeometry(d / 2, d / 2, l, 48, 1, true),
    tagged('sleeve', {color: ctx.tex(`cap-${p.label}`, c)}, {offset: p.labelTurn ?? 0.25}));
  // Aluminium top with the scored K vent, the rolled sleeve edge, the
  // crimp bead below it and the rubber bung the leads leave through.
  const alu = ctx.material('zinc', '#c3c7cd');
  const cap = mesh(new THREE.CylinderGeometry(d / 2 - 0.45, d / 2 - 0.45, 0.3, 48), alu);
  cap.position.y = l / 2 - 0.2;
  const groove = ctx.material('plastic', '#5c6066');
  const vents = [[0, 0, d * 0.62, 0], [0, 0, d * 0.62, Math.PI / 2]].map(([x, z, len, rot]) => {
    const v = mesh(new THREE.BoxGeometry(len, 0.08, 0.28), groove);
    v.position.set(x, l / 2 - 0.02, z);
    v.rotation.y = rot;
    return v;
  });
  const rim = mesh(new THREE.TorusGeometry(d / 2 - 0.3, 0.38, 10, 48), ctx.material('plastic', '#16171a'));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = l / 2 - 0.15;
  const bead = mesh(new THREE.TorusGeometry(d / 2 - 0.05, 0.18, 8, 48), ctx.material('plastic', '#16171a'));
  bead.rotation.x = Math.PI / 2;
  bead.position.y = -l / 2 + 2.2;
  const base = mesh(new THREE.CylinderGeometry(d / 2 - 0.4, d / 2 - 0.4, 0.6, 40), ctx.material('rubber', '#2a2b2e'));
  base.position.y = -l / 2 - 0.2;
  const body = new THREE.Group();
  body.add(sleeve, cap, ...vents, rim, bead, base);
  body.rotation.x = -Math.PI / 2; // axis along +Z, top toward -Z
  body.rotation.y = Math.PI / 2;
  body.position.y = d / 2;
  const leadLen = p.lead ?? 18;
  const leads = [-1, 1].map((s) => {
    const m = mesh(new THREE.CylinderGeometry(0.3, 0.3, leadLen, 10), ctx.material('zinc', '#c9ccd0'));
    m.rotation.x = Math.PI / 2;
    m.position.set(s * 2.5, d / 2, l / 2 + leadLen / 2);
    return m;
  });
  return wrap(body, ...leads);
}

// JST-SH 1.0 mm 8-pin FC-to-ESC cable, after the shipped cable: two
// natural-white housings 9.5 x 4.25 x 2.95 mm with side ears at the wire
// end and contact slots on the mating face, joined by `len` mm (25) of
// 32 AWG leads laid as a tight, nearly straight flat ribbon with one slight bow. Lead colours in
// order: red, black, green, yellow, then four white.
function jstCable(p, ctx) {
  const pins = p.pins ?? 8;
  const run = p.len ?? 25;
  const hw = p.housingW ?? 9.5;
  const hd = 4.25;
  const hh = 2.95;
  const od = 0.66;
  const nylon = ctx.material('nylon', '#f1eee6');
  const dark = ctx.material('plastic', '#4a4740');
  const gold = ctx.material('gold', '#e2b24e');
  const cols = p.colors ?? ['#c42a22', '#17181b', '#2f8f4b', '#e2c200', '#ecebe6', '#ecebe6', '#ecebe6', '#ecebe6'];
  const z0 = -run / 2;
  const parts = [];
  for (const end of [-1, 1]) {
    const zc = end * (run / 2 + hd / 2);
    const geo = new THREE.ExtrudeGeometry(roundedRect(hw, hd, 0.3), {depth: hh - 0.24, bevelEnabled: true,
      bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 2, curveSegments: 6});
    geo.rotateX(Math.PI / 2);
    geo.translate(0, hh - 0.12, 0);
    const body = mesh(geo, nylon);
    body.position.z = zc;
    parts.push(body);
    // Side ears at the wire end.
    for (const sx of [-1, 1]) {
      const ear = mesh(new THREE.BoxGeometry(0.6, hh * 0.55, 1.1), nylon);
      ear.position.set(sx * (hw / 2 + 0.25), hh * 0.275, zc - end * (hd / 2 - 0.55));
      parts.push(ear);
    }
    // Mating face (the outer end): one slot per contact, gold inside.
    const face = zc + end * (hd / 2 + 0.01);
    for (let i = 0; i < pins; i++) {
      const x = (i - (pins - 1) / 2) * 1.0;
      const slot = mesh(new THREE.BoxGeometry(0.62, 1.3, 0.06), dark);
      slot.position.set(x, hh * 0.52, face);
      const pin = mesh(new THREE.BoxGeometry(0.26, 0.5, 0.07), gold);
      pin.position.set(x, hh * 0.45, face + end * 0.005);
      parts.push(slot, pin);
      // Lance windows on the top face.
      const win = mesh(new THREE.BoxGeometry(0.5, 0.04, 1.2), dark);
      win.position.set(x, hh + 0.01, zc + end * 0.7);
      parts.push(win);
    }
  }
  // Ribbon centre line: one gentle bow (peak 0.9 mm at mid-span), no S.
  const bow = (t) => 0.9 * Math.sin(Math.PI * t);
  const N = 90;
  for (let i = 0; i < pins; i++) {
    const pts = [];
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const c = new THREE.Vector3(bow(t), 0, z0 + t * run);
      const dxdz = (0.9 * Math.PI * Math.cos(Math.PI * t)) / run;
      const tl = Math.hypot(dxdz, 1);
      const tan = new THREE.Vector3(dxdz / tl, 0, 1 / tl);
      const fromEnd = Math.min(t, 1 - t) * run;
      // 1.0 mm contact pitch at the housings, closing to a touching ribbon.
      const pitch = od + 0.01 + (0.8 - od - 0.01) * Math.max(0, 1 - fromEnd / 3);
      const o = ((pins - 1) / 2 - i) * pitch;
      const y = od / 2 + (hh * 0.45 - od / 2) * Math.max(0, 1 - fromEnd / 3);
      pts.push(new THREE.Vector3(c.x - tan.z * o, y, c.z + tan.x * o));
    }
    pts.unshift(new THREE.Vector3(pts[0].x, pts[0].y, pts[0].z - 1.5));
    pts.push(new THREE.Vector3(pts[pts.length - 1].x, pts[pts.length - 1].y, pts[pts.length - 1].z + 1.5));
    parts.push(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, od / 2, 10, false),
      ctx.material('silicone', cols[i % cols.length])));
  }
  return wrap(...parts);
}

// Clear heat-shrink sleeve, flattened: `len` x `w` mm. A frosted, translucent
// flat tube (elliptical section) with brighter folded side edges and rims.
function heatShrink(p) {
  const len = p.len ?? 20;
  const w = p.w ?? 12;
  const t = 1.0;
  const film = tagged('shrink');
  const fold = tagged('shrink-edge');
  const tube = mesh(new THREE.CylinderGeometry(1, 1, len, 40, 1, true), film);
  tube.rotation.x = Math.PI / 2;
  tube.scale.set(w / 2, 1, t / 2);
  tube.position.y = t / 2;
  const parts = [tube];
  for (const s of [-1, 1]) {
    const edge = mesh(new THREE.CylinderGeometry(t * 0.32, t * 0.32, len, 12), fold);
    edge.rotation.x = Math.PI / 2;
    edge.position.set(s * (w / 2 - t * 0.3), t / 2, 0);
    parts.push(edge);
    const rim = mesh(new THREE.TorusGeometry(1, 0.05, 6, 48), fold);
    rim.scale.set(w / 2, t / 2, 1);
    rim.position.set(0, t / 2, (s * len) / 2);
    parts.push(rim);
  }
  return wrap(...parts);
}

// A board as a flat card at true size, textured with its rendered board
// art (the front face export of scripts/export-board-art.mjs); the face
// PNG's alpha cuts the outline, stacked layers give the PCB edge.
async function boardCard(p, ctx) {
  const geo = new THREE.PlaneGeometry(p.imageW, p.imageH);
  geo.rotateX(-Math.PI / 2);
  const tex = {color: ctx.tex(`board-${p.board}`, {url: p.src})};
  const layers = [];
  const top = mesh(geo, tagged('image', tex));
  top.position.y = p.thick ?? 1.0;
  layers.push(top);
  for (let i = 0; i < 4; i++) {
    const m = mesh(geo, tagged('image-edge', tex));
    m.position.y = ((p.thick ?? 1.0) * i) / 4;
    layers.push(m);
  }
  return wrap(...layers);
}

// Black socket-head cap screw (ISO 4762) lying on its side, head toward +Z
// (the camera), resting on head rim and thread tip. Head d x k: M2 3.8 x 2,
// M3 5.5 x 3; hex socket 1.5 / 2.5 mm; thread as rolled ridges at the pitch.
function screw(p, ctx) {
  const d = p.d ?? 3;
  const L = p.len ?? 8;
  const dk = d === 2 ? 3.8 : d === 2.5 ? 4.5 : d === 3 ? 5.5 : 1.83 * d;
  const k = d;
  const sAF = d === 2 ? 1.5 : d === 2.5 ? 2 : d === 3 ? 2.5 : 0.8 * d;
  const pitch = d === 2 ? 0.4 : d === 2.5 ? 0.45 : d === 3 ? 0.5 : 0.15 * d;
  const steel = ctx.material('steel', '#2e3136');
  // Shank profile along +Y: tip chamfer, thread ridges, head underside at L.
  const prof = [new THREE.Vector2(0, 0), new THREE.Vector2(d / 2 - 0.2, 0)];
  for (let y = 0.25; y < L - 0.3; y += pitch) {
    prof.push(new THREE.Vector2(d / 2, y + pitch * 0.25), new THREE.Vector2(d / 2 - 0.55 * pitch, y + pitch * 0.75));
  }
  prof.push(new THREE.Vector2(d / 2 - 0.05, L), new THREE.Vector2(0, L));
  const shank = mesh(new THREE.LatheGeometry(prof, 28), steel);
  // Head: cylinder with a hex socket, knurled-looking chamfer kept simple.
  const outer = new THREE.Shape();
  outer.absarc(0, 0, dk / 2, 0, Math.PI * 2, false);
  const hex = new THREE.Path();
  for (let i = 0; i <= 6; i++) {
    const a = (i * Math.PI) / 3;
    const r = sAF / Math.sqrt(3);
    if (i) hex.lineTo(r * Math.cos(a), r * Math.sin(a));
    else hex.moveTo(r * Math.cos(a), r * Math.sin(a));
  }
  outer.holes.push(hex);
  const headGeo = new THREE.ExtrudeGeometry(outer, {depth: k - 0.2, bevelEnabled: true, bevelThickness: 0.2,
    bevelSize: 0.2, bevelSegments: 3, curveSegments: 40});
  headGeo.rotateX(-Math.PI / 2);
  const head = mesh(headGeo, steel);
  head.position.y = L;
  const floor = mesh(new THREE.CylinderGeometry(sAF / 2, sAF / 2, 0.1, 6), ctx.material('plastic', '#0c0d0f'));
  floor.position.y = L + k * 0.45;
  const g = new THREE.Group();
  g.add(shank, head, floor);
  // Axis along +Z with the head at +Z, then the rest tilt on head rim + tip.
  g.rotation.x = Math.PI / 2;
  const tilt = Math.atan2((dk - d) / 2, L + k / 2);
  const outerG = new THREE.Group();
  outerG.add(g);
  outerG.rotation.x = -tilt;
  outerG.position.set(0, dk / 2, -(L + k) / 2);
  return wrap(outerG);
}

// Nylon-insert lock nut (ISO 10511) lying flat: hex AF x height, M5 8 x 5 mm,
// black steel with the white nylon collar and its bore on top.
function nut(p, ctx) {
  const d = p.d ?? 5;
  const af = p.af ?? (d === 5 ? 8 : 1.6 * d);
  const hgt = p.h ?? (d === 5 ? 5 : d);
  const steel = ctx.material('steel', '#2e3136');
  const hexShape = new THREE.Shape();
  const r = af / Math.sqrt(3);
  for (let i = 0; i <= 6; i++) {
    const a = (i * Math.PI) / 3 + Math.PI / 6;
    if (i) hexShape.lineTo(r * Math.cos(a), r * Math.sin(a));
    else hexShape.moveTo(r * Math.cos(a), r * Math.sin(a));
  }
  const bore = new THREE.Path();
  bore.absarc(0, 0, d / 2, 0, Math.PI * 2, true);
  hexShape.holes.push(bore);
  const body = new THREE.ExtrudeGeometry(hexShape, {depth: hgt * 0.62, bevelEnabled: true, bevelThickness: 0.25,
    bevelSize: 0.25, bevelSegments: 2, curveSegments: 32});
  body.rotateX(-Math.PI / 2);
  body.translate(0, 0.25, 0);
  const collarShape = new THREE.Shape();
  collarShape.absarc(0, 0, af * 0.46, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, d * 0.42, 0, Math.PI * 2, true);
  collarShape.holes.push(hole);
  const collarSteel = new THREE.ExtrudeGeometry(collarShape, {depth: hgt * 0.38 - 0.25, bevelEnabled: true,
    bevelThickness: 0.2, bevelSize: 0.2, bevelSegments: 2, curveSegments: 32});
  collarSteel.rotateX(-Math.PI / 2);
  collarSteel.translate(0, hgt * 0.62 + 0.25, 0);
  const ringShape = new THREE.Shape();
  ringShape.absarc(0, 0, af * 0.34, 0, Math.PI * 2, false);
  ringShape.holes.push(hole);
  const ring = new THREE.ExtrudeGeometry(ringShape, {depth: 0.2, bevelEnabled: false, curveSegments: 32});
  ring.rotateX(-Math.PI / 2);
  ring.translate(0, hgt + 0.02, 0);
  return wrap(mesh(body, steel), mesh(collarSteel, steel), mesh(ring, ctx.material('nylon', '#ecebe6')));
}

const BUILDERS = {screw, nut, card, sticker, esdBag, strap, cupWasher, grommet, wireSet, xtPigtail, capacitor, jstCable,
  heatShrink, boardCard};

export async function buildProcedural(spec, ctx) {
  const b = BUILDERS[spec.kind];
  if (!b) throw new Error(`unknown procedural kind: ${spec.kind}`);
  const g = await b(spec, ctx);
  g.updateMatrixWorld(true);
  return g;
}
