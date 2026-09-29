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

// A flat plate from a 2D shape drawn in (x, z), extruded upward by `thick`.
function plate(shape, thick, mat, bevel = 0) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thick,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 16,
  });
  geo.rotateX(Math.PI / 2); // shape (x, y) -> (x, z); extrusion -> -y
  geo.translate(0, thick, 0);
  return mesh(geo, mat);
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

// Static-shielding bag: metallised film, faintly pink, zip strip, printed
// OpenDrone wordmark and ESD caution mark.
async function esdBag(p, ctx) {
  const w = p.w ?? 80;
  const h = p.h ?? 100;
  const c = sheetCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#cfc3c8';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(120,108,114,0.55)';
  g.lineWidth = 2.2 * PX_PER_MM;
  g.strokeRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(120,108,114,0.45)';
  g.fillRect(0, 9 * PX_PER_MM, c.width, 0.7 * PX_PER_MM);
  g.fillRect(0, 11 * PX_PER_MM, c.width, 0.7 * PX_PER_MM);
  const s = Math.min(w, h) * 0.11 * PX_PER_MM;
  const cy = c.height * 0.8;
  const cx = c.width * 0.18;
  g.beginPath();
  g.moveTo(cx, cy - s * 0.55);
  g.lineTo(cx + s * 0.6, cy + s * 0.5);
  g.lineTo(cx - s * 0.6, cy + s * 0.5);
  g.closePath();
  g.fillStyle = '#e8b400';
  g.fill();
  g.lineWidth = s * 0.07;
  g.strokeStyle = '#1a1a1e';
  g.stroke();
  await drawArt(g, ctx.assets.opendrone, c.width * 0.34, c.height * 0.775, c.width * 0.5, c.height * 0.05, '#85787f');
  const geo = footprintUv(new THREE.ExtrudeGeometry(roundedRect(w, h, 1), {depth: 0.25, bevelEnabled: false})
    .rotateX(Math.PI / 2).translate(0, 0.25, 0));
  return wrap(mesh(geo, tagged('bag', {color: ctx.tex(`bag-${w}x${h}`, c)})));
}

// Battery strap: woven nylon webbing `w` x `len` mm, 1.4 mm thick, with a
// woven gold OpenDrone repeat on the outer face, a zigzag silicone grip
// bead on the inner face, box-X stitching at the buckle end, a sealed tip
// and a black anodised cam buckle ((w + 6) x 14 x 2.2 mm). `side` picks
// the face that lies up; the free end curls up off the table.
let strapN = 0;
async function strap(p, ctx) {
  const w = p.w ?? 20;
  const len = p.len ?? 220;
  const t = 1.4;
  const inner = (p.side ?? (strapN % 2 ? 'inner' : 'outer')) === 'inner';
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
  g.fillStyle = '#131417';
  g.fillRect(0, 0, cw, ch);
  hh.fillStyle = '#808080';
  hh.fillRect(0, 0, cw, ch);
  r.fillStyle = '#c8c8c8';
  r.fillRect(0, 0, cw, ch);
  // Fine twill weave: 0.5 mm ribs on a diagonal, in height and a touch in tone.
  for (let y = 0; y < ch; y += 2) {
    for (let x = 0; x < cw; x += 2) {
      const on = ((x + y) >> 1) % 3 === 0;
      hh.fillStyle = on ? '#9a9a9a' : '#707070';
      hh.fillRect(x, y, 2, 2);
      if (on) {
        g.fillStyle = 'rgba(255,255,255,0.035)';
        g.fillRect(x, y, 2, 2);
      }
    }
  }
  // Selvedge ribs along both edges.
  for (const x of [0, cw - 6]) {
    hh.fillStyle = '#b0b0b0';
    hh.fillRect(x, 0, 6, ch);
  }
  if (!inner) {
    // Woven wordmark repeat, running along the strap.
    const step = 55 * PX;
    for (let y = 30 * PX; y < ch - 30 * PX; y += step) {
      for (const [ctx2, colr] of [[g, 'rgba(236,172,0,0.92)'], [hh, '#a8a8a8']]) {
        ctx2.save();
        ctx2.translate(cw / 2, y);
        ctx2.rotate(-Math.PI / 2);
        await drawArt(ctx2, ctx.assets.opendrone, -22 * PX, -w * 0.28 * PX, 44 * PX, w * 0.56 * PX, colr);
        ctx2.restore();
      }
    }
  } else {
    // Zigzag silicone grip bead down the middle, glossier and raised.
    const gw = w * 0.5 * PX;
    const x0 = (cw - gw) / 2;
    for (const [ctx2, style] of [[g, '#2a2c30'], [hh, '#e0e0e0'], [r, '#4a4a4a']]) {
      ctx2.strokeStyle = style;
      ctx2.lineWidth = 1.1 * PX;
      ctx2.lineJoin = 'round';
      ctx2.beginPath();
      for (let y = 26 * PX, i = 0; y < ch - 24 * PX; y += 3 * PX, i++) {
        const x = i % 2 ? x0 + gw : x0;
        if (i) ctx2.lineTo(x, y);
        else ctx2.moveTo(x, y);
      }
      ctx2.stroke();
    }
  }
  // Box-X stitching at the buckle end, a stitched line near the tip.
  const stitch = (x1, y1, x2, y2) => {
    const n = Math.hypot(x2 - x1, y2 - y1) / (1.6 * PX);
    for (let i = 0; i < n; i++) {
      const a = i / n;
      const b = (i + 0.6) / n;
      for (const [ctx2, style] of [[g, '#4a4c52'], [hh, '#c0c0c0']]) {
        ctx2.strokeStyle = style;
        ctx2.lineWidth = 0.45 * PX;
        ctx2.beginPath();
        ctx2.moveTo(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a);
        ctx2.lineTo(x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
        ctx2.stroke();
      }
    }
  };
  const bx0 = 2 * PX;
  const bx1 = cw - 2 * PX;
  const by0 = 9 * PX;
  const by1 = 22 * PX;
  stitch(bx0, by0, bx1, by0);
  stitch(bx1, by0, bx1, by1);
  stitch(bx1, by1, bx0, by1);
  stitch(bx0, by1, bx0, by0);
  stitch(bx0, by0, bx1, by1);
  stitch(bx1, by0, bx0, by1);
  stitch(bx0, ch - 8 * PX, bx1, ch - 8 * PX);
  // Webbing geometry: a ribbon along Z with a rounded, sealed tip; the last
  // 30 mm lift off the table in a gentle curl.
  const N = 220;
  const pos = [];
  const uv = [];
  const idx = [];
  const lift = (z) => {
    const k = Math.max(0, (z - (len - 32)) / 32);
    return 5 * k * k;
  };
  const halfW = (z) => {
    const tip = len - z;
    return tip < w / 2 ? Math.sqrt(Math.max(0, (w / 2) ** 2 - (w / 2 - tip) ** 2)) : w / 2;
  };
  for (let i = 0; i <= N; i++) {
    const z = (len * i) / N;
    const hw = Math.max(0.3, halfW(z));
    const y = lift(z);
    for (const [yy, face] of [[y + t, 0], [y, 1]]) {
      for (const sx of [-1, 1]) {
        pos.push(sx * hw, yy, z - len / 2);
        uv.push((sx * hw) / w + 0.5, 1 - z / len);
      }
    }
  }
  const row = 4;
  for (let i = 0; i < N; i++) {
    const a = i * row;
    const b = (i + 1) * row;
    idx.push(a, b, a + 1, a + 1, b, b + 1); // top
    idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2); // bottom
    idx.push(a, a + 2, b, a + 2, b + 2, b); // side -x
    idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3); // side +x
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  // Top face gets this side's weave; the other faces the plain weave.
  geo.addGroup(0, N * 6, 0);
  geo.addGroup(N * 6, N * 18, 1);
  geo.computeVertexNormals();
  const texs = {color: ctx.tex(`${id}-c`, col), height: ctx.tex(`${id}-h`, hgt), rough: ctx.tex(`${id}-r`, rgh)};
  const web = mesh(geo, [tagged('webbing', texs), tagged('webbing', {height: texs.height})]);
  if (inner) web.rotation.z = 0;
  // Cam buckle over the stitched end.
  const outer = roundedRect(w + 6, 14, 3);
  const slot = roundedRect(w + 1, 3.6, 1.4);
  outer.holes.push(new THREE.Path(slot.getPoints().map((pt) => new THREE.Vector2(pt.x, pt.y - 2.4))));
  const bucGeo = new THREE.ExtrudeGeometry(outer, {depth: 2.2, bevelEnabled: true, bevelThickness: 0.35,
    bevelSize: 0.35, bevelSegments: 3, curveSegments: 24});
  bucGeo.rotateX(Math.PI / 2);
  bucGeo.translate(0, 2.2 + 0.35, 0);
  const buckle = mesh(bucGeo, tagged('alu-brushed', {}, {color: '#16171a'}));
  buckle.position.set(0, t, -len / 2 + 7);
  return wrap(web, buckle);
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

// A loose set of parallel wires, e.g. the 28 AWG four-colour hook-up set.
function wireSet(p, ctx) {
  const {od, core} = AWG[p.awg ?? 28];
  const len = p.len ?? 100;
  const colors = p.colors ?? ['red', 'black', 'yellow', 'white'];
  const pitch = od + (p.spacing ?? 1.6);
  const parts = [];
  colors.forEach((col, i) => {
    const x = (i - (colors.length - 1) / 2) * pitch;
    const bow = (i % 2 ? 1 : -1) * 0.8;
    parts.push(...wire([[x, -len / 2], [x + bow, 0], [x, len / 2]], od, WIRE_COLOURS[col] ?? col, 3, core, false, ctx));
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
    const x0 = (s * pitch) / 2;
    const x1 = s * (pitch / 2 + 2.5);
    parts.push(...wire([[x0, 4], [x0 + (x1 - x0) * 0.6, 4 + len * 0.4], [x1, 4 + len]], od, i ? WIRE_COLOURS.red : WIRE_COLOURS.black, 6, core, true, ctx)
      .map((m) => {
        m.position.y += bh / 2 + 0.3 - od / 2;
        return m;
      }));
  });
  const g = wrap(...parts);
  return g;
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
  const cap = mesh(new THREE.CircleGeometry(d / 2 - 0.4, 40), ctx.material('zinc', '#b8bcc2'));
  cap.rotation.x = -Math.PI / 2;
  cap.position.y = l / 2;
  const rim = mesh(new THREE.TorusGeometry(d / 2 - 0.2, 0.35, 10, 48), new THREE.MeshPhysicalMaterial({color: '#16171a', roughness: 0.3}));
  rim.rotation.x = Math.PI / 2;
  rim.position.y = l / 2 - 0.1;
  const base = mesh(new THREE.CircleGeometry(d / 2, 40), new THREE.MeshStandardMaterial({color: '#2a2b2e', roughness: 0.8}));
  base.rotation.x = Math.PI / 2;
  base.position.y = -l / 2;
  const body = new THREE.Group();
  body.add(sleeve, cap, rim, base);
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

// JST-SH 1.0 mm 8-pin cable: eight 30 AWG wires, housing at both ends
// (9.9 x 2.95 x 4.25 mm, natural nylon).
function jstCable(p, ctx) {
  const pins = p.pins ?? 8;
  const len = p.len ?? 80;
  const hw = pins * 1.0 + 1.9;
  const nylon = ctx.material('nylon', '#e7e1d1');
  const cols = ['#17181b', '#c42a22', '#e2b400', '#2a64c8', '#2f9a4b', '#e6e6e2', '#7a4fc0', '#e0701f'];
  const parts = [];
  for (const z of [-len / 2, len / 2]) {
    const h = mesh(new THREE.BoxGeometry(hw, 2.95, 4.25), nylon);
    h.position.set(0, 2.95 / 2, z);
    parts.push(h);
  }
  for (let i = 0; i < pins; i++) {
    const x = (i - (pins - 1) / 2) * 1.0;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x, 1.2, -len / 2),
      new THREE.Vector3(x * 1.05, 0.4, 0),
      new THREE.Vector3(x, 1.2, len / 2),
    ]);
    parts.push(mesh(new THREE.TubeGeometry(curve, 48, 0.36, 8, false), ctx.material('silicone', cols[i % cols.length])));
  }
  return wrap(...parts);
}

// Clear heat-shrink sleeve, flattened: `len` x `w` mm. Two film layers
// with brighter folded edges, the way a flat clear tube reads.
function heatShrink(p) {
  const len = p.len ?? 20;
  const w = p.w ?? 13;
  const film = tagged('clear');
  const fold = tagged('clear-edge');
  const parts = [];
  for (const y of [0.1, 0.45]) {
    const m = mesh(new THREE.BoxGeometry(w - 0.8, 0.1, len), film);
    m.position.y = y;
    parts.push(m);
  }
  for (const s of [-1, 1]) {
    const edge = mesh(new THREE.CylinderGeometry(0.3, 0.3, len, 10), fold);
    edge.rotation.x = Math.PI / 2;
    edge.position.set((s * (w - 0.6)) / 2, 0.3, 0);
    parts.push(edge);
  }
  for (const s of [-1, 1]) {
    const rim = mesh(new THREE.BoxGeometry(w - 0.6, 0.5, 0.25), fold);
    rim.position.set(0, 0.3, (s * len) / 2);
    parts.push(rim);
  }
  return wrap(...parts);
}

// U.FL T-dipole: 1.13 mm coax lead `lead` mm with the U.FL plug, two
// shrink-covered legs `leg` mm each side of the T.
function tDipole(p, ctx) {
  const lead = p.lead ?? 100;
  const leg = p.leg ?? 29;
  // 1.13 mm coax is grey; the legs are black shrink over the radiators.
  const black = ctx.material('silicone', '#2a2c31');
  const grey = ctx.material('silicone', '#7b7e84');
  const parts = [];
  const coax = mesh(new THREE.CylinderGeometry(0.57, 0.57, lead, 12), grey);
  coax.rotation.x = Math.PI / 2;
  coax.position.set(0, 0.9, lead / 2);
  parts.push(coax);
  const gold = ctx.material('gold', '#d9a531');
  const plug = mesh(new THREE.CylinderGeometry(1.0, 1.0, 1.25, 24), gold);
  plug.position.set(0, 0.63, -0.8);
  const plugBody = mesh(new THREE.BoxGeometry(2.6, 0.9, 3.2), ctx.material('nylon', '#e7e1d1'));
  plugBody.position.set(0, 0.45, 0.3);
  parts.push(plugBody, plug);
  const hub = mesh(new THREE.BoxGeometry(4.5, 2.0, 6), black);
  hub.position.set(0, 1.0, lead + 2);
  parts.push(hub);
  for (const s of [-1, 1]) {
    const arm = mesh(new THREE.CylinderGeometry(0.95, 0.95, leg, 14), black);
    arm.rotation.z = Math.PI / 2;
    arm.position.set((s * leg) / 2 + s * 2.2, 0.95, lead + 3.5);
    parts.push(arm);
    const tipCap = mesh(new THREE.SphereGeometry(0.95, 14, 10), black);
    tipCap.position.set(s * (leg + 2.2), 0.95, lead + 3.5);
    parts.push(tipCap);
    if (p.dualBand) {
      // Dual band: a trap sleeve partway out each leg.
      const trap = mesh(new THREE.CylinderGeometry(1.35, 1.35, 7, 16), black);
      trap.rotation.z = Math.PI / 2;
      trap.position.set(s * (2.2 + leg * 0.4), 1.35, lead + 3.5);
      parts.push(trap);
    }
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

const BUILDERS = {card, sticker, esdBag, strap, cupWasher, grommet, wireSet, xtPigtail, capacitor, jstCable,
  heatShrink, tDipole, boardCard};

export async function buildProcedural(spec, ctx) {
  const b = BUILDERS[spec.kind];
  if (!b) throw new Error(`unknown procedural kind: ${spec.kind}`);
  const g = await b(spec, ctx);
  g.updateMatrixWorld(true);
  return g;
}
