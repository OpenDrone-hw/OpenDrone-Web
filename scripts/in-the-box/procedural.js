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

function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
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

// ---- Builders --------------------------------------------------------------

// Printed card: `w` x `h` mm, 0.4 mm board, 3 mm corners. Dark card, gold
// OpenDrone wordmark, one small caption line.
async function card(p, ctx) {
  const w = p.w ?? 85;
  const h = p.h ?? 55;
  const c = sheetCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#1a1a1e';
  g.fillRect(0, 0, c.width, c.height);
  const markW = c.width * 0.62;
  await drawArt(g, ctx.assets.opendrone, (c.width - markW) / 2, c.height * 0.3, markW, c.height * 0.22, '#ffb700');
  if (p.caption) {
    g.fillStyle = 'rgba(229,229,229,0.72)';
    g.font = `500 ${Math.round(Math.min(c.height * 0.055, c.width * 0.05))}px Helvetica, Arial, sans-serif`;
    g.textAlign = 'center';
    g.fillText(p.caption, c.width / 2, c.height * 0.7);
  }
  const geo = footprintUv(new THREE.ExtrudeGeometry(roundedRect(w, h, 3), {depth: 0.4, bevelEnabled: false})
    .rotateX(Math.PI / 2).translate(0, 0.4, 0));
  const mat = new THREE.MeshStandardMaterial({map: canvasTexture(c), roughness: 0.62, metalness: 0});
  return wrap(mesh(geo, mat));
}

// Die-cut vinyl sticker: gold wordmark on a black rounded rectangle.
async function sticker(p, ctx) {
  const w = p.w ?? 80;
  const h = p.h ?? 22;
  const c = sheetCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#121214';
  g.fillRect(0, 0, c.width, c.height);
  await drawArt(g, ctx.assets.opendrone, c.width * 0.08, c.height * 0.2, c.width * 0.84, c.height * 0.6, '#ffb700');
  const geo = footprintUv(new THREE.ExtrudeGeometry(roundedRect(w, h, h * 0.22), {depth: 0.25, bevelEnabled: false})
    .rotateX(Math.PI / 2).translate(0, 0.25, 0));
  const mat = new THREE.MeshPhysicalMaterial({map: canvasTexture(c), roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2});
  return wrap(mesh(geo, mat));
}

// Static-shielding bag: metallised film, faintly pink, zip strip, printed
// OpenDrone wordmark and ESD caution mark.
async function esdBag(p, ctx) {
  const w = p.w ?? 80;
  const h = p.h ?? 100;
  const c = sheetCanvas(w, h);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, c.width, c.height);
  grad.addColorStop(0, '#c9bcc2');
  grad.addColorStop(0.5, '#ddd2d6');
  grad.addColorStop(1, '#bfb3b9');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // Heat seal border and zip strip.
  g.strokeStyle = 'rgba(120,108,114,0.55)';
  g.lineWidth = 2.2 * PX_PER_MM;
  g.strokeRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(120,108,114,0.45)';
  g.fillRect(0, 9 * PX_PER_MM, c.width, 0.7 * PX_PER_MM);
  g.fillRect(0, 11 * PX_PER_MM, c.width, 0.7 * PX_PER_MM);
  // ESD caution triangle.
  const s = Math.min(w, h) * 0.11 * PX_PER_MM;
  const cy = c.height * 0.8;
  const cxT = c.width * 0.18;
  g.beginPath();
  g.moveTo(cxT, cy - s * 0.55);
  g.lineTo(cxT + s * 0.6, cy + s * 0.5);
  g.lineTo(cxT - s * 0.6, cy + s * 0.5);
  g.closePath();
  g.fillStyle = '#e8b400';
  g.fill();
  g.lineWidth = s * 0.07;
  g.strokeStyle = '#1a1a1e';
  g.stroke();
  g.beginPath();
  g.moveTo(cxT - s * 0.18, cy + s * 0.3);
  g.lineTo(cxT + s * 0.06, cy - s * 0.18);
  g.lineTo(cxT + s * 0.18, cy + s * 0.3);
  g.stroke();
  await drawArt(g, ctx.assets.opendrone, c.width * 0.34, c.height * 0.775, c.width * 0.5, c.height * 0.05, '#85787f');
  const geo = footprintUv(new THREE.ExtrudeGeometry(roundedRect(w, h, 1), {depth: 0.25, bevelEnabled: false})
    .rotateX(Math.PI / 2).translate(0, 0.25, 0));
  const mat = new THREE.MeshPhysicalMaterial({
    map: canvasTexture(c),
    metalness: 0.55,
    roughness: 0.38,
    transparent: true,
    opacity: 0.86,
    clearcoat: 0.4,
  });
  return wrap(mesh(geo, mat));
}

// Hook-and-loop battery strap with a black anodised cam buckle. Webbing
// `w` x `len` mm, 1.5 mm thick; buckle (w + 5) x 13 x 2.6 mm.
function strap(p, ctx) {
  const w = p.w ?? 20;
  const len = p.len ?? 220;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#18191c';
  g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 64; i += 4) {
    g.fillStyle = i % 8 ? '#202226' : '#141518';
    g.fillRect(0, i, 64, 2);
  }
  const tex = canvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const webGeo = new THREE.ExtrudeGeometry(roundedRect(w, len, w * 0.45), {depth: 1.5, bevelEnabled: false})
    .rotateX(Math.PI / 2).translate(0, 1.5, 0);
  footprintUv(webGeo);
  tex.repeat.set(1, len / 1.2 / 16);
  const web = mesh(webGeo, new THREE.MeshStandardMaterial({map: tex, roughness: 0.85}));
  // Silicone grip line down the middle of the non-hook half.
  const grip = mesh(new THREE.BoxGeometry(w * 0.35, 0.5, len * 0.42), new THREE.MeshStandardMaterial({color: '#2c2e33', roughness: 0.45}));
  grip.position.set(0, 1.75, len * 0.18);
  const outer = roundedRect(w + 5, 13, 2.5);
  const slot = roundedRect(w + 0.8, 3.4, 1.2);
  const hole = new THREE.Path(slot.getPoints().map((pt) => new THREE.Vector2(pt.x, pt.y - 2.2)));
  outer.holes.push(hole);
  const buckle = plate(outer, 2.6, ctx.material('alu', '#1b1c1f', {roughness: 0.5}));
  buckle.position.set(0, 0.8, -len / 2 + 3);
  return wrap(web, grip, buckle);
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
  const tex = canvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.offset.x = p.labelTurn ?? 0.25;
  const sleeve = mesh(new THREE.CylinderGeometry(d / 2, d / 2, l, 48, 1, true),
    new THREE.MeshPhysicalMaterial({map: tex, roughness: 0.32, clearcoat: 0.5}));
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
  const film = new THREE.MeshPhysicalMaterial({color: '#eef2f6', roughness: 0.15, clearcoat: 1, transparent: true,
    opacity: 0.13, metalness: 0, depthWrite: false});
  const fold = new THREE.MeshPhysicalMaterial({color: '#f4f7fa', roughness: 0.2, clearcoat: 1, transparent: true,
    opacity: 0.75, metalness: 0});
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
// art (the front face export of scripts/export-board-art.mjs).
async function boardCard(p) {
  const tex = await new THREE.TextureLoader().loadAsync(p.src);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const geo = new THREE.PlaneGeometry(p.imageW, p.imageH);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({map: tex, alphaTest: 0.5, roughness: 0.55, metalness: 0.05,
    side: THREE.DoubleSide});
  const layers = [];
  const top = mesh(geo, mat);
  top.position.y = p.thick ?? 1.0;
  layers.push(top);
  // The PCB edge: the same outline stacked below the face, in solder mask.
  const edge = new THREE.MeshStandardMaterial({map: tex, alphaTest: 0.5, color: '#2a2f2c', roughness: 0.6,
    side: THREE.DoubleSide});
  for (let i = 0; i < 4; i++) {
    const m = mesh(geo, edge);
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
