// Minimap core, pure module: no imports, no DOM. Runs in node for the unit tests (tests/unit/minimap.test.mjs).
// - World to map: data/minimap.json worldToMap m, px = m0*x + m1*z + m2, py = m3*x + m4*z + m5 (WORLD x, z in u).
//   The map is drawn in the room frame (tools/bake_minimap.py), map up is "north" on the minimap.
// - Fog of war: a grid of fog cells over the map (data/minimap.json fog). Reveal casts rays from the visitor over 360
//   degrees up to a radius; a ray stops after the first occluder cell (shelves, cabinets, walls: the "tall" cells of
//   the plan), which is revealed itself so the obstacle shows. Benches and tables do not block sight.
// - Edge arrow: a target outside the minimap circle is shown by an arrow on the rim pointing at it.
// No allocation in the per-frame paths: results go into caller-supplied objects.

const DEG = Math.PI / 180;

function b64ToBytes(s) {
  if (typeof atob === 'function') {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function bytesToB64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

// bitmask, bit i of byte i >> 3, LSB first (the layout of data/nav.json)
export function decodeBits(b64, n) {
  const bytes = b64ToBytes(b64);
  if (bytes.length !== Math.ceil(n / 8)) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return out;
}

export function encodeBits(arr) {
  const bytes = new Uint8Array(Math.ceil(arr.length / 8));
  for (let i = 0; i < arr.length; i++) if (arr[i]) bytes[i >> 3] |= 1 << (i & 7);
  return bytesToB64(bytes);
}

// meta: data/minimap.json. Returns { toMap(x, z, out), toWorld(px, py, out), headingOnMap(yawDeg), ppu, width, height }
export function createTransform(meta) {
  const m = meta.worldToMap;
  const det = m[0] * m[4] - m[1] * m[3];
  if (!Array.isArray(m) || m.length !== 6 || !Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error('minimap: bad worldToMap');
  const i0 = m[4] / det, i1 = -m[1] / det, i3 = -m[3] / det, i4 = m[0] / det;
  return {
    ppu: Math.sqrt(Math.abs(det)),
    width: meta.width,
    height: meta.height,
    toMap(x, z, out) { out.x = m[0] * x + m[1] * z + m[2]; out.y = m[3] * x + m[4] * z + m[5]; return out; },
    toWorld(px, py, out) {
      const qx = px - m[2], qy = py - m[5];
      out.x = i0 * qx + i1 * qy; out.z = i3 * qx + i4 * qy;
      return out;
    },
    // the visitor's facing on the map, radians clockwise from map up (yaw 0 looks toward -Z, positive turns left)
    headingOnMap(yawDeg) {
      const fx = -Math.sin(yawDeg * DEG), fz = -Math.cos(yawDeg * DEG);
      const dx = m[0] * fx + m[1] * fz, dy = m[3] * fx + m[4] * fz;
      return Math.atan2(dx, -dy);
    }
  };
}

// rotate (dx, dy) in screen coordinates (y down) by -heading, so the facing direction points up
export function rotateToView(dx, dy, heading, out) {
  const c = Math.cos(heading), s = Math.sin(heading);
  out.x = dx * c + dy * s;
  out.y = -dx * s + dy * c;
  return out;
}

// Edge arrow for a circular minimap of radius r (px) centred on 0, 0. (dx, dy): target relative to the centre in view
// coordinates. inside: the target is drawn in place; otherwise x, y is on the circle r - margin toward it and angle is
// the arrow direction, radians clockwise from up.
export function edgeArrow(dx, dy, r, margin, out) {
  const d = Math.hypot(dx, dy);
  const lim = r - margin;
  out.angle = Math.atan2(dx, -dy);
  if (d <= lim) { out.inside = true; out.x = dx; out.y = dy; return out; }
  out.inside = false;
  out.x = (dx / d) * lim;
  out.y = (dy / d) * lim;
  return out;
}

// Fog of war over the map. fogMeta: data/minimap.json fog { w, h, pxPerCell, occluders }.
export function createFog(fogMeta, { rays = 240 } = {}) {
  const w = fogMeta.w, h = fogMeta.h, pc = fogMeta.pxPerCell;
  const n = w * h;
  const occ = (fogMeta.occluders && decodeBits(fogMeta.occluders, n)) || new Uint8Array(n);
  const seen = new Uint8Array(n);
  const cosT = new Float64Array(rays), sinT = new Float64Array(rays);
  for (let k = 0; k < rays; k++) { cosT[k] = Math.cos((2 * Math.PI * k) / rays); sinT[k] = Math.sin((2 * Math.PI * k) / rays); }
  let count = 0;
  const dirty = { x0: w, y0: h, x1: -1, y1: -1 };
  const mark = (i, j) => {
    const k = j * w + i;
    if (seen[k]) return 0;
    seen[k] = 1;
    count++;
    if (i < dirty.x0) dirty.x0 = i;
    if (j < dirty.y0) dirty.y0 = j;
    if (i > dirty.x1) dirty.x1 = i;
    if (j > dirty.y1) dirty.y1 = j;
    return 1;
  };
  return {
    w, h, pxPerCell: pc, occluders: occ, cells: seen,
    get count() { return count; },
    get fraction() { return count / n; },
    // reveal from map position (px, py) within radiusPx. Returns the number of newly revealed cells.
    reveal(px, py, radiusPx) {
      const fx = px / pc, fy = py / pc, R = radiusPx / pc;
      let added = 0;
      const ci = Math.floor(fx), cj = Math.floor(fy);
      if (ci >= 0 && cj >= 0 && ci < w && cj < h) added += mark(ci, cj);
      const step = 0.5;
      for (let k = 0; k < rays; k++) {
        const c = cosT[k], s = sinT[k];
        for (let t = step; t <= R; t += step) {
          const i = Math.floor(fx + c * t), j = Math.floor(fy + s * t);
          if (i < 0 || j < 0 || i >= w || j >= h) break;
          added += mark(i, j);
          if (occ[j * w + i]) break;
        }
      }
      return added;
    },
    isRevealed(i, j) { return i >= 0 && j >= 0 && i < w && j < h && seen[j * w + i] === 1; },
    revealedAtMap(px, py) { return this.isRevealed(Math.floor(px / pc), Math.floor(py / pc)); },
    // the bounding box of cells revealed since the last call, or null; resets it
    takeDirty(out) {
      if (dirty.x1 < 0) return null;
      out.x0 = dirty.x0; out.y0 = dirty.y0; out.x1 = dirty.x1; out.y1 = dirty.y1;
      dirty.x0 = w; dirty.y0 = h; dirty.x1 = -1; dirty.y1 = -1;
      return out;
    },
    serialize() { return encodeBits(seen); },
    // loads a serialized fog; a string of the wrong length or not base64 is ignored. Returns true when loaded.
    load(b64) {
      if (typeof b64 !== 'string') return false;
      let bits = null;
      try { bits = decodeBits(b64, n); } catch (err) { bits = null; }
      if (!bits) return false;
      seen.set(bits);
      count = 0;
      for (let i = 0; i < n; i++) count += bits[i];
      dirty.x0 = 0; dirty.y0 = 0; dirty.x1 = w - 1; dirty.y1 = h - 1;
      return true;
    },
    reset() {
      seen.fill(0);
      count = 0;
      dirty.x0 = 0; dirty.y0 = 0; dirty.x1 = w - 1; dirty.y1 = h - 1;
    }
  };
}
