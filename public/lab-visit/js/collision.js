// Walk-grid collision for the Lab Visit game. SPEC.md section 2.5. Pure module: no imports, no DOM, no PlayCanvas.
// All coordinates are WORLD XZ in world units (1 u is about 2.7 m).
//
// Decisions where the spec is silent:
// - The distance transform treats the ring of cells just outside the grid as blocked (spec 2.1: outside is blocked).
// - move() also accepts a substep that does not lower clearance, so a player that starts in a non-walkable spot
//   can walk out instead of being frozen. It still never returns a position less walkable than `from`.
// - findPath() connects a snapped endpoint to the nearest walkable cell centre whose straight segment is walkable.
// - createCollisionFromGrid() takes an optional pathCoverage for stats().

export const COLLISION_EPS = 0.002;
const DEFAULT_RADIUS = 0.065;
const INF = 1e20;

// ---------- bitmask ----------

export function encodeBlocked(blocked) {
  const n = blocked.length;
  const bytes = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if (blocked[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeBlocked(base64, w, h) {
  const s = atob(base64);
  const n = w * h;
  if (s.length !== Math.ceil(n / 8)) throw new Error(`bitmask length ${s.length} does not match ${Math.ceil(n / 8)}`);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (s.charCodeAt(i >> 3) >> (i & 7)) & 1;
  return out;
}

// ---------- exact Euclidean distance transform (Felzenszwalb and Huttenlocher) ----------

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

// Returns Float64Array(w*h): distance in cells from each cell centre to the nearest blocked cell centre,
// with a blocked border ring around the grid.
function distanceTransform(blocked, w, h) {
  const W = w + 2, H = h + 2;
  const g = new Float64Array(W * H);
  for (let iz = 0; iz < H; iz++) {
    for (let ix = 0; ix < W; ix++) {
      const inside = ix > 0 && iz > 0 && ix <= w && iz <= h;
      g[iz * W + ix] = !inside || blocked[(iz - 1) * w + (ix - 1)] ? 0 : INF;
    }
  }
  const n = Math.max(W, H);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let ix = 0; ix < W; ix++) {
    for (let iz = 0; iz < H; iz++) f[iz] = g[iz * W + ix];
    edt1d(f, H, d, v, z);
    for (let iz = 0; iz < H; iz++) g[iz * W + ix] = d[iz];
  }
  for (let iz = 0; iz < H; iz++) {
    for (let ix = 0; ix < W; ix++) f[ix] = g[iz * W + ix];
    edt1d(f, W, d, v, z);
    for (let ix = 0; ix < W; ix++) g[iz * W + ix] = d[ix];
  }
  const out = new Float64Array(w * h);
  for (let iz = 0; iz < h; iz++) {
    for (let ix = 0; ix < w; ix++) out[iz * w + ix] = Math.sqrt(g[(iz + 1) * W + (ix + 1)]);
  }
  return out;
}

// ---------- binary heap for A* ----------

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const k = this.k, p = this.p;
    let i = k.length;
    k.push(key); p.push(pri);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (p[j] <= pri) break;
      k[i] = k[j]; p[i] = p[j]; i = j;
    }
    k[i] = key; p[i] = pri;
  }
  pop() {
    const k = this.k, p = this.p;
    const top = k[0];
    const lk = k.pop(), lp = p.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && p[c + 1] < p[c]) c++;
        if (p[c] >= lp) break;
        k[i] = k[c]; p[i] = p[c]; i = c;
      }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}

// ---------- constructors ----------

export function createCollisionFromGrid({ origin, cell, w, h, floorY, blocked, source = 'nav', pathCoverage = null }) {
  if (blocked.length !== w * h) throw new Error('blocked length does not match w*h');
  const ox = origin[0], oz = origin[1];
  const half = cell / 2;
  const Dc = distanceTransform(blocked, w, h);
  const D = new Float64Array(w * h);
  for (let i = 0; i < D.length; i++) D[i] = Dc[i] * cell;
  const walkCache = new Map();

  const Dat = (ix, iz) => (ix < 0 || iz < 0 || ix >= w || iz >= h ? 0 : D[iz * w + ix]);
  const centre = (i) => ({ x: ox + ((i % w) + 0.5) * cell, z: oz + (Math.floor(i / w) + 0.5) * cell });

  function clearance(x, z) {
    const fx = (x - ox) / cell - 0.5, fz = (z - oz) / cell - 0.5;
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const a = Dat(ix, iz) * (1 - tx) + Dat(ix + 1, iz) * tx;
    const b = Dat(ix, iz + 1) * (1 - tx) + Dat(ix + 1, iz + 1) * tx;
    const v = a * (1 - tz) + b * tz;
    return Math.max(0, v - half);
  }

  const isWalkable = (x, z, radius = DEFAULT_RADIUS) => clearance(x, z) >= radius - COLLISION_EPS;

  function normalAt(x, z) {
    const s = cell / 2;
    const gx = (clearance(x + s, z) - clearance(x - s, z)) / (2 * s);
    const gz = (clearance(x, z + s) - clearance(x, z - s)) / (2 * s);
    const len = Math.hypot(gx, gz);
    return len < 1e-6 ? null : [gx / len, gz / len];
  }

  function resolveCapsule(pos, radius = DEFAULT_RADIUS) {
    let x = pos.x, z = pos.z, pushed = false, normal = null;
    for (let it = 0; it < 3; it++) {
      const c = clearance(x, z);
      if (c >= radius) break;
      const n = normalAt(x, z);
      if (!n) break;
      const d = radius - c + 1e-4;
      x += n[0] * d;
      z += n[1] * d;
      pushed = true;
      normal = n;
    }
    return { x, z, pushed, normal };
  }

  function move(from, delta, radius = DEFAULT_RADIUS) {
    const len = Math.hypot(delta.x, delta.z);
    const n = Math.max(1, Math.ceil(len / (0.25 * radius)));
    const sx = delta.x / n, sz = delta.z / n;
    let px = from.x, pz = from.z, pc = clearance(px, pz);
    let blocked = false, normal = null;
    for (let i = 0; i < n; i++) {
      const r = resolveCapsule({ x: px + sx, z: pz + sz }, radius);
      const rc = clearance(r.x, r.z);
      if (rc < radius - COLLISION_EPS && rc < pc) {
        blocked = true;
        normal = r.normal || normalAt(px + sx, pz + sz) || normal;
        continue;
      }
      if (r.pushed) { blocked = true; normal = r.normal; }
      px = r.x; pz = r.z; pc = rc;
    }
    return { x: px, z: pz, blocked, normal };
  }

  function walkMask(radius) {
    const key = radius.toFixed(6);
    let m = walkCache.get(key);
    if (!m) {
      m = new Uint8Array(w * h);
      const need = radius - COLLISION_EPS + half;
      for (let i = 0; i < m.length; i++) m[i] = D[i] >= need ? 1 : 0;
      walkCache.set(key, m);
    }
    return m;
  }

  function nearestWalkable(x, z, radius = DEFAULT_RADIUS, maxDist = 1.0) {
    if (isWalkable(x, z, radius)) return { x, z };
    const m = walkMask(radius);
    const r = Math.ceil(maxDist / cell) + 1;
    const cx = Math.floor((x - ox) / cell), cz = Math.floor((z - oz) / cell);
    let best = null, bestD = maxDist * maxDist;
    for (let iz = Math.max(0, cz - r); iz <= Math.min(h - 1, cz + r); iz++) {
      for (let ix = Math.max(0, cx - r); ix <= Math.min(w - 1, cx + r); ix++) {
        if (!m[iz * w + ix]) continue;
        const px = ox + (ix + 0.5) * cell, pz = oz + (iz + 0.5) * cell;
        const d = (px - x) * (px - x) + (pz - z) * (pz - z);
        if (d <= bestD) { bestD = d; best = { x: px, z: pz }; }
      }
    }
    return best;
  }

  function segmentWalkable(a, b, radius) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / (cell / 2)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (!isWalkable(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, radius)) return false;
    }
    return true;
  }

  // Walkable cell centre to anchor a snapped point on the A* graph.
  function graphNode(p, radius, m) {
    const cx = Math.floor((p.x - ox) / cell), cz = Math.floor((p.z - oz) / cell);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= 3 && best < 0; r++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        for (let ix = cx - r; ix <= cx + r; ix++) {
          if (ix < 0 || iz < 0 || ix >= w || iz >= h) continue;
          const i = iz * w + ix;
          if (!m[i]) continue;
          const c = centre(i);
          const d = Math.hypot(c.x - p.x, c.z - p.z);
          if (d < bestD && segmentWalkable(p, c, radius)) { bestD = d; best = i; }
        }
      }
    }
    return best;
  }

  function findPath(from, to, radius = DEFAULT_RADIUS) {
    const a = nearestWalkable(from.x, from.z, radius);
    const b = nearestWalkable(to.x, to.z, radius);
    if (!a || !b) return null;
    if (segmentWalkable(a, b, radius)) return [a, b];
    const m = walkMask(radius);
    const s = graphNode(a, radius, m), g = graphNode(b, radius, m);
    if (s < 0 || g < 0) return null;
    const gx = g % w, gz = Math.floor(g / w);
    const hfun = (i) => {
      const dx = Math.abs((i % w) - gx), dz = Math.abs(Math.floor(i / w) - gz);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    const gs = new Float64Array(w * h).fill(Infinity);
    const came = new Int32Array(w * h).fill(-1);
    const closed = new Uint8Array(w * h);
    const heap = new MinHeap();
    gs[s] = 0;
    heap.push(s, hfun(s));
    let found = false;
    while (heap.size) {
      const c = heap.pop();
      if (closed[c]) continue;
      if (c === g) { found = true; break; }
      closed[c] = 1;
      const cx = c % w, cz = Math.floor(c / w);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
          const ni = nz * w + nx;
          if (!m[ni] || closed[ni]) continue;
          if (dx && dz && (!m[cz * w + nx] || !m[nz * w + cx])) continue;
          const ng = gs[c] + (dx && dz ? Math.SQRT2 : 1);
          if (ng < gs[ni]) { gs[ni] = ng; came[ni] = c; heap.push(ni, ng + hfun(ni)); }
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let c = g; c >= 0; c = came[c]) { cells.push(centre(c)); if (c === s) break; }
    cells.reverse();
    const raw = [a, ...cells, b];
    const out = [raw[0]];
    let i = 0;
    while (i < raw.length - 1) {
      let j = raw.length - 1;
      while (j > i + 1 && !segmentWalkable(raw[i], raw[j], radius)) j--;
      out.push(raw[j]);
      i = j;
    }
    return out;
  }

  function stats() {
    const m = walkMask(DEFAULT_RADIUS);
    let walkableCells = 0, mi = 0;
    for (let i = 0; i < m.length; i++) { walkableCells += m[i]; if (D[i] > D[mi]) mi = i; }
    const c = centre(mi);
    return {
      source, w, h, cell, walkableCells,
      pathCoverage,
      maxClearance: { x: c.x, z: c.z, value: Math.max(0, D[mi] - half) },
    };
  }

  return {
    source,
    floorY,
    bounds: { minX: ox, minZ: oz, maxX: ox + w * cell, maxZ: oz + h * cell },
    floorHeightAt: () => floorY,
    clearance, isWalkable, normalAt, resolveCapsule, move, nearestWalkable, findPath, stats,
  };
}

export function createCollisionFromNav(nav) {
  if (nav.frame !== 'WORLD') throw new Error(`nav frame ${nav.frame}`);
  const blocked = decodeBlocked(nav.blocked, nav.w, nav.h);
  return createCollisionFromGrid({
    origin: nav.origin, cell: nav.cell, w: nav.w, h: nav.h, floorY: nav.floorY, blocked, source: 'nav',
    pathCoverage: nav.pathCoverage ?? null,
  });
}

// Point in polygon, even-odd rule. poly: [[x, z], ...].
export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, z1] = poly[i], [x2, z2] = poly[j];
    if ((z1 > z) !== (z2 > z) && x < ((x2 - x1) * (z - z1)) / (z2 - z1) + x1) inside = !inside;
  }
  return inside;
}

// Blocks every cell that the start cell cannot reach, the same rule as tools/bake_nav.py step 5: free cells farther
// than radius + cell from a reachable walkable cell centre, and walkable centres in other components. Repeats until
// stable, so no unreachable island is left for nearestWalkable to snap into.
export function pruneUnreachable(blocked, w, h, cell, start, radius = DEFAULT_RADIUS) {
  const need = radius - COLLISION_EPS + cell / 2;
  const keepR = (radius + cell) / cell + 1e-9;
  const offs = [];
  for (let dz = -Math.ceil(keepR); dz <= Math.ceil(keepR); dz++) {
    for (let dx = -Math.ceil(keepR); dx <= Math.ceil(keepR); dx++) if (Math.hypot(dx, dz) < keepR) offs.push([dx, dz]);
  }
  for (let iter = 0; iter < 10; iter++) {
    const D = distanceTransform(blocked, w, h);
    const walk = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) walk[i] = D[i] * cell >= need ? 1 : 0;
    if (start < 0 || start >= w * h || !walk[start]) return blocked;
    const reach = new Uint8Array(w * h);
    const q = [start];
    reach[start] = 1;
    while (q.length) {
      const c = q.pop();
      const cx = c % w, cz = (c - cx) / w;
      if (cx > 0 && walk[c - 1] && !reach[c - 1]) { reach[c - 1] = 1; q.push(c - 1); }
      if (cx < w - 1 && walk[c + 1] && !reach[c + 1]) { reach[c + 1] = 1; q.push(c + 1); }
      if (cz > 0 && walk[c - w] && !reach[c - w]) { reach[c - w] = 1; q.push(c - w); }
      if (cz < h - 1 && walk[c + w] && !reach[c + w]) { reach[c + w] = 1; q.push(c + w); }
    }
    const keep = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!reach[i]) continue;
      const cx = i % w, cz = (i - cx) / w;
      for (const [dx, dz] of offs) {
        const nx = cx + dx, nz = cz + dz;
        if (nx >= 0 && nz >= 0 && nx < w && nz < h) keep[nz * w + nx] = 1;
      }
    }
    let changed = 0;
    for (let i = 0; i < w * h; i++) {
      if (!blocked[i] && (!keep[i] || (walk[i] && !reach[i]))) { blocked[i] = 1; changed++; }
    }
    if (!changed) return blocked;
  }
  return blocked;
}

// Fallback grid, used when data/nav.json is absent or invalid. With a walk path (data/walkpath.json), only the
// corridor a person walked during the scan is free: cells within FALLBACK_CORRIDOR of a recorded path segment, of an
// item approach point or of the spawn. Without one, the whole scene box is free. In both cases the box edge band and
// the polygons of data/furniture.json are blocked, and every area the spawn cannot reach is blocked. The fallback
// does not know the benches and tables that tools/bake_nav.py finds in the splat, so it is a degraded mode: a
// visitor can walk onto furniture that the walk path crosses.
export const FALLBACK_CORRIDOR = 0.2;

export function createFallbackCollision(scene, machines, walkpath = null, furniture = null) {
  const cell = 0.02;
  const minX = scene.boxMin[0], minZ = scene.boxMin[2], maxX = scene.boxMax[0], maxZ = scene.boxMax[2];
  const w = Math.ceil((maxX - minX) / cell), h = Math.ceil((maxZ - minZ) / cell);
  const items = ((machines && machines.items) || []).filter(Boolean);
  const polys = ((furniture && furniture.polygons) || []).map((p) => p.points).filter((p) => Array.isArray(p) && p.length >= 3);
  const corridor = walkpath && Array.isArray(walkpath.positions) && walkpath.positions.length ? (() => {
    const free = new Uint8Array(w * h);
    const C = FALLBACK_CORRIDOR;
    const mark = (ax, az, bx, bz) => {
      const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
      const ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - C - minX) / cell));
      const ix1 = Math.min(w - 1, Math.floor((Math.max(ax, bx) + C - minX) / cell));
      const iz0 = Math.max(0, Math.floor((Math.min(az, bz) - C - minZ) / cell));
      const iz1 = Math.min(h - 1, Math.floor((Math.max(az, bz) + C - minZ) / cell));
      for (let iz = iz0; iz <= iz1; iz++) {
        const cz = minZ + (iz + 0.5) * cell;
        for (let ix = ix0; ix <= ix1; ix++) {
          const cx = minX + (ix + 0.5) * cell;
          let t = L > 0 ? ((cx - ax) * dx + (cz - az) * dz) / L : 0;
          t = Math.max(0, Math.min(1, t));
          if (Math.hypot(cx - ax - t * dx, cz - az - t * dz) <= C) free[iz * w + ix] = 1;
        }
      }
    };
    const P = walkpath.positions;
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)], b = P[i];
      mark(a[0], a[2], b[0], b[2]);
    }
    for (const it of items) if (it.approach && it.approach.pos) mark(it.approach.pos[0], it.approach.pos[1], it.approach.pos[0], it.approach.pos[1]);
    if (machines && machines.spawn && machines.spawn.pos) mark(machines.spawn.pos[0], machines.spawn.pos[1], machines.spawn.pos[0], machines.spawn.pos[1]);
    return free;
  })() : null;
  const blocked = new Uint8Array(w * h);
  for (let iz = 0; iz < h; iz++) {
    const cz = minZ + (iz + 0.5) * cell;
    for (let ix = 0; ix < w; ix++) {
      const cx = minX + (ix + 0.5) * cell;
      let b = cx - minX < 0.05 || maxX - cx < 0.05 || cz - minZ < 0.05 || maxZ - cz < 0.05;
      if (!b && corridor) b = !corridor[iz * w + ix];
      for (let k = 0; !b && k < polys.length; k++) b = pointInPolygon(cx, cz, polys[k]);
      blocked[iz * w + ix] = b ? 1 : 0;
    }
  }
  const sp = machines && machines.spawn && machines.spawn.pos;
  if (sp) pruneUnreachable(blocked, w, h, cell, Math.floor((sp[1] - minZ) / cell) * w + Math.floor((sp[0] - minX) / cell));
  return createCollisionFromGrid({ origin: [minX, minZ], cell, w, h, floorY: scene.floorY, blocked, source: 'fallback' });
}

async function fetchFurniture(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    return r.status === 200 ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

export async function loadCollision({ navUrl = 'data/nav.json', scene, machines, walkpath = null, furnitureUrl = 'data/furniture.json' }) {
  let reason;
  if (navUrl === null) {
    console.warn('collision: fallback', 'no navUrl');
    return createFallbackCollision(scene, machines, walkpath, await fetchFurniture(furnitureUrl));
  }
  try {
    const res = await fetch(navUrl);
    if (res.status !== 200) {
      reason = `HTTP ${res.status}`;
    } else {
      const nav = await res.json();
      if (nav.frame !== 'WORLD') reason = `frame ${nav.frame}`;
      else return createCollisionFromNav(nav);
    }
  } catch (e) {
    reason = String((e && e.message) || e);
  }
  console.warn('collision: fallback', reason);
  return createFallbackCollision(scene, machines, walkpath, await fetchFurniture(furnitureUrl));
}
