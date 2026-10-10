#!/usr/bin/env node
/**
 * Export the public testing evidence for the /testing page.
 *
 * The private bench app computes every figure; this script asks it for the
 * numbers, reduces them to chart size, and writes three files that the
 * storefront bundles at build time:
 *
 *   content/testing/figures.json   the charts (points, setup, caveats)
 *   content/testing/timeline.json  the engineering log
 *   content/testing/meta.json      when, from what, which schema
 *
 * Only items with status "publish" are written to content/testing/. Items
 * marked "needs-review" go to the git-ignored .testing-held/held.json, so
 * held evidence is never committed or bundled into the public client.
 *
 *   node scripts/sync-testing.mjs --write   regenerate the three files
 *   node scripts/sync-testing.mjs --check   exit 1 on drift or a banned string
 *   add --offline to skip the app and use the capture files
 *
 * Inputs
 *   - The bench app, read only. TESTING_API (default http://127.0.0.1:8787).
 *     Exactly two calls exist: POST /api/numbers/figure (pure computation)
 *     and GET /api/fields. Any other path throws before a request is made.
 *     The app may be driving a real rig; nothing here arms, runs or saves.
 *   - The capture files, for the thrust stand holds (the app's own hold
 *     reduction needs a current clamp, which that stand does not have) and as
 *     the fallback when the app is down. TESTING_REPO (default
 *     /Users/stan/Incutec/testing). Fallback covers bench captures only
 *     (frames, bins, last-N-seconds holds); figures that need the app's hold,
 *     sweep, field or flight reductions are carried over from the files on
 *     disk and meta.json says so.
 *   - scripts/testing-export.config.json: all prose, in public language. The
 *     exporter never copies a note, finding or name from the app.
 *
 * Honesty gate (also re-checked by app/lib/testing-content.ts)
 *   - a simulated response or manifest is refused;
 *   - thrust stand runs (drv-04-*) may only export rpm, thrust_g, thr, v_bus,
 *     tesc_max: the stand's current sense is not calibrated;
 *   - strings are scanned for paths, names, regulatory and price patterns
 *     and em dashes; the offending field is named and the script exits 1;
 *   - every number quoted in a finding is pinned by a config check.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const CONFIG = path.join(HERE, 'testing-export.config.json');
const OUT_DIR = path.join(WEB_ROOT, 'content', 'testing');
/** Items marked needs-review are written here (git-ignored), never to OUT_DIR. */
const HELD_FILE = path.join(WEB_ROOT, '.testing-held', 'held.json');

const API = (process.env.TESTING_API || 'http://127.0.0.1:8787').replace(/\/$/, '');
const REPO = process.env.TESTING_REPO || '/Users/stan/Incutec/testing';

const mode = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--check')
    ? 'check'
    : null;
if (!mode) {
  console.error('usage: sync-testing.mjs --write | --check [--offline]');
  process.exit(2);
}
const OFFLINE = process.argv.includes('--offline');

// ------------------------------------------------------------------ contract

const PRODUCTS = new Set(['openesc', 'openmotor', 'openrx', 'openfc-lite', 'openframe']);
const TIERS = new Set(['20x20', '30x30']);
const KINDS = new Set(['line', 'scatter', 'band']);
const ROLES = new Set(['measured', 'reference']);
const STYLES = new Set(['solid', 'dashed', 'points']);
const SOURCE_KINDS = new Set(['bench', 'thrust-stand', 'field-ride', 'flight-log']);
const STATUSES = new Set(['publish', 'needs-review']);
const MAX_POINTS = 400;
const MAX_FILE_BYTES = 300 * 1024;

/** Fields a thrust stand run may export. Its current sense is uncalibrated. */
const THRUST_STAND_FIELDS = new Set(['rpm', 'thrust_g', 'thr', 'thr_pct', 'v_bus', 'tesc_max']);
const THRUST_STAND_RUN = /^drv-04-/;
const BANNED_FIELD = /^(i_a|i_raw|i_shunt|p_shunt|eff_gw|clamp_a|i_clamp|p_bus|i_total|i1)$|power|gw/i;

/** Strings that must never reach the public repository. */
const BANNED_TEXT = [
  [/\/Volumes/, 'a local volume path'],
  [/Private/, 'the private tree'],
  [/siliXcon/, 'a supplier name'],
  [/\bCE\b/, 'a compliance record'],
  [/EN 300/, 'a regulatory standard'],
  [/OpenFC-Core/, 'the NDA component'],
  [/[€$£]\s?\d|\d\s?(€|EUR\b|USD\b)/, 'a price'],
  [/LCSC/, 'a supplier part number source'],
  [/—/, 'an em dash'],
  [/\/Users\//, 'a home directory path'],
];

/** Keys the app returns that must not be copied. */
const STRIP_KEYS = new Set(['raw_points', 'raw_count', 'cites', 'color', 'width', 'operator']);

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

// ----------------------------------------------------------------- utilities

const sig4 = (v) => (v === 0 ? 0 : Number(Number(v).toPrecision(4)));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Linear-interpolated quantile, the usual definition. */
function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Min/max per time bucket: both extremes of every bucket survive, so a spike
 * is never lost the way every-nth-point thinning loses it.
 */
function minmax(points, buckets) {
  if (points.length <= buckets * 2) return points;
  const x0 = points[0][0];
  const x1 = points[points.length - 1][0];
  const w = (x1 - x0) / buckets || 1;
  const bins = new Map();
  for (const p of points) {
    const k = Math.min(buckets - 1, Math.floor((p[0] - x0) / w));
    const b = bins.get(k);
    if (!b) bins.set(k, {lo: p, hi: p});
    else {
      if (p[1] < b.lo[1]) b.lo = p;
      if (p[1] > b.hi[1]) b.hi = p;
    }
  }
  const out = new Set([points[0], points[points.length - 1]]);
  for (const b of bins.values()) {
    out.add(b.lo);
    out.add(b.hi);
  }
  return points.filter((p) => out.has(p));
}

/** Bin by x width: median y, p25 and p75. Bin centre is the x. */
function binPoints(points, width, xmin) {
  const bins = new Map();
  for (const [x, y] of points) {
    const k = Math.floor((x - xmin) / width);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(y);
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  return keys.map((k) => {
    const ys = bins.get(k);
    return {
      x: xmin + (k + 0.5) * width,
      y: median(ys),
      lo: quantile(ys, 0.25),
      hi: quantile(ys, 0.75),
      n: ys.length,
    };
  });
}

// ------------------------------------------------------------------ app API

/** The only two calls this script can make. */
const ALLOWED = new Set(['POST /api/numbers/figure', 'GET /api/fields']);

async function api(method, route, body) {
  if (!ALLOWED.has(`${method} ${route}`)) {
    throw new Error(`refused: ${method} ${route} is not on the read-only allow-list`);
  }
  const res = await fetch(API + route, {
    method,
    headers: body ? {'content-type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`${method} ${route} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

let appFields = null; // field -> unit, when the app answered
async function probeApp() {
  if (OFFLINE) return false;
  try {
    const r = await fetch(API + '/api/fields', {signal: AbortSignal.timeout(4000)});
    if (!r.ok) return false;
    const j = await api('GET', '/api/fields');
    appFields = new Map(j.fields.map((f) => [f.field, f.unit]));
    return true;
  } catch {
    return false;
  }
}

const REDUCE_OF = {
  'app-hold': 'hold',
  'app-sweep': 'sweep',
  'app-frames': 'frames',
  'app-raw': 'raw',
  'app-raw-share': 'raw',
};

function appSpec(fig) {
  const sources = [];
  const sid = new Map();
  for (const s of fig.series) {
    const ref = s.ref || `log:${s.run}`;
    if (!sid.has(ref)) {
      sid.set(ref, `s${sid.size + 1}`);
      sources.push({id: sid.get(ref), ref, label: sid.get(ref), enabled: true});
    }
  }
  const r = fig.reduce;
  return {
    id: fig.id,
    title: fig.id,
    kind: 'xy',
    sources,
    x: {field: fig.xField, scale: 'linear', min: null, max: null},
    series: fig.series.map((s) => {
      const id = `${sid.get(s.ref || `log:${s.run}`)}.${s.field}.${s.id}`;
      return {
        id,
        source: sid.get(s.ref || `log:${s.run}`),
        field: s.field,
        axis: 'left',
        style: r.mode === 'app-raw-share' ? 'scatter' : 'line',
        visible: true,
        ...(s.band ? {band: 'spread'} : {}),
        _key: s.id,
      };
    }),
    reduce: r.mode === 'app-bin' ? {bin: r.bin} : REDUCE_OF[r.mode],
    filters: {},
  };
}

/** Post one figure spec and index the returned series by our series id. */
async function runApp(fig) {
  const spec = appSpec(fig);
  const keys = spec.series.map((s) => s._key);
  for (const s of spec.series) delete s._key;
  const res = await api('POST', '/api/numbers/figure', spec);
  if (res.simulated === true) throw new Error(`${fig.id}: the app reports a simulated capture`);
  if (!Array.isArray(res.series) || res.series.length !== keys.length) {
    throw new Error(`${fig.id}: the app returned ${res.series?.length} series, expected ${keys.length}`);
  }
  const out = new Map();
  res.series.forEach((s, i) => {
    out.set(keys[i], {
      field: s.field,
      unit: s.unit,
      points: (s.points || []).filter((p) => finite(p[0]) && finite(p[1])).map((p) => [p[0], p[1]]),
      lo: s.band?.lo || [],
      hi: s.band?.hi || [],
    });
  });
  for (const k of Object.keys(res)) if (STRIP_KEYS.has(k)) delete res[k];
  return {series: out, xUnit: res.x?.unit};
}

// ------------------------------------------------------------- capture files

function findRun(run) {
  for (const dir of [path.join(REPO, 'Logs', run), path.join(REPO, 'Logs', '_archive', run)]) {
    if (fs.existsSync(path.join(dir, 'bench.csv'))) return dir;
  }
  throw new Error(`capture ${run}: no bench.csv under ${REPO}/Logs`);
}

const benchCache = new Map();
function loadBench(run) {
  if (benchCache.has(run)) return benchCache.get(run);
  const dir = findRun(run);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  if (manifest.simulated === true || (manifest.instruments || []).some((i) => i.simulated === true)) {
    throw new Error(`${run}: the manifest marks this capture simulated`);
  }
  const lines = fs.readFileSync(path.join(dir, 'bench.csv'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const head = lines[0].split(',');
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const rows = lines.slice(1).map((l) => {
    const c = l.split(',');
    const num = (name) => {
      const i = col[name];
      if (i === undefined || c[i] === '' || c[i] === undefined) return null;
      const v = Number(c[i]);
      return Number.isFinite(v) ? v : null;
    };
    return {num, evt: c[col.evt]};
  });
  const t0 = rows.length ? rows[0].num('t_ms') : 0;
  const bench = {rows, t0, manifest, poles: manifest.motor_poles || manifest.poles || 14};
  benchCache.set(run, bench);
  return bench;
}

/** The app's field vocabulary, read from a capture row. */
function benchField(bench, row, field, motor) {
  switch (field) {
    case 't':
      return (row.num('t_ms') - bench.t0) / 1000;
    case 'thr':
      return row.num(`thr${motor}`);
    case 'thr_pct': {
      const v = row.num(`thr${motor}`);
      return v === null ? null : v / 10;
    }
    case 'rpm': {
      const e = row.num(`erpm${motor}`);
      return e === null ? null : e / (bench.poles / 2);
    }
    case 'i_shunt':
      return row.num('i_a');
    case 'i_clamp':
      return row.num('clamp_a');
    case 'v_bus':
      return row.num('v_v');
    case 'thrust_g':
      return row.num('thrust_g');
    case 'tesc4':
      return row.num('tesc4');
    case 'tesc_max': {
      const v = [1, 2, 3, 4].map((m) => row.num(`tesc${m}`)).filter(finite);
      return v.length ? Math.max(...v) : null;
    }
    default:
      throw new Error(`no capture-file reduction for field ${field}`);
  }
}

/** Constant-throttle segments, the same rule the app uses (5 permille, 2 s). */
function dwells(bench, motor, minMs) {
  const out = [];
  const {rows} = bench;
  let s = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i < rows.length && Math.abs(rows[i].num(`thr${motor}`) - rows[s].num(`thr${motor}`)) <= 5) continue;
    if (rows[i - 1].num('t_ms') - rows[s].num('t_ms') >= minMs) out.push([s, i - 1]);
    s = i;
  }
  return out;
}

function holdLast(fig, s) {
  const run = loadBench(s.run);
  const motor = cfg.runs[s.run]?.motor ?? 1;
  const r = fig.reduce;
  const pts = [];
  for (const [a, b] of dwells(run, motor, r.minDwellMs)) {
    const thr = median(run.rows.slice(a, b + 1).map((row) => row.num(`thr${motor}`)));
    if (!(thr > r.drivenThrAbove)) continue;
    const tEnd = run.rows[b].num('t_ms');
    const win = run.rows.slice(a, b + 1).filter((row) => row.num('t_ms') > tEnd - r.seconds * 1000);
    const bus = median(win.map((row) => benchField(run, row, 'v_bus', motor)).filter(finite));
    if (r.dropBelowBusV !== undefined && !(bus >= r.dropBelowBusV)) continue;
    const xs = win.map((row) => benchField(run, row, s.xField || fig.xField, motor)).filter(finite);
    const ys = win.map((row) => benchField(run, row, s.field, motor)).filter(finite);
    if (!xs.length || !ys.length) continue;
    pts.push({x: median(xs), y: median(ys), lo: quantile(ys, 0.25), hi: quantile(ys, 0.75)});
  }
  return pts;
}

/** Fallback frames / bin from a bench capture. */
function benchSeries(fig, s) {
  const run = loadBench(s.run);
  const motor = cfg.runs[s.run]?.motor ?? 1;
  const pts = [];
  for (const row of run.rows) {
    const x = benchField(run, row, fig.xField, motor);
    const y = benchField(run, row, s.field, motor);
    if (finite(x) && finite(y)) pts.push([x, y]);
  }
  return pts;
}

// ---------------------------------------------------------------- the build

const prev = (() => {
  const m = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'figures.json'), 'utf8'));
    for (const f of j.figures) m.set(f.id, f);
  } catch {
    /* none */
  }
  try {
    const j = JSON.parse(fs.readFileSync(HELD_FILE, 'utf8'));
    for (const f of j.figures || []) m.set(f.id, f);
  } catch {
    /* none */
  }
  return m;
})();

const usedSources = new Set(); // 'app' | 'files' | 'carried'

function gateSeriesField(fig, s) {
  if (!THRUST_STAND_RUN.test(s.run || '')) return;
  if (!THRUST_STAND_FIELDS.has(s.field) || BANNED_FIELD.test(s.field)) {
    throw new Error(`${fig.id}: a thrust stand run may not export ${s.field}`);
  }
}

function clip(points, lo, hi) {
  return points.filter((p) => (lo === undefined || lo === null || p[0] >= lo) && (hi === undefined || hi === null || p[0] <= hi));
}

async function buildFigure(fig, appUp) {
  for (const s of fig.series) gateSeriesField(fig, s);
  const r = fig.reduce;
  const visible = fig.series.filter((s) => !s.hidden);
  let result; // Map seriesId -> {points, lo?, hi?}
  let used;

  if (r.mode === 'hold-last') {
    result = new Map();
    for (const s of fig.series) {
      const pts = holdLast(fig, s).sort((a, b) => a.x - b.x);
      result.set(s.id, {
        points: pts.map((p) => [p.x, p.y]),
        lo: r.band ? pts.map((p) => [p.x, p.lo]) : [],
        hi: r.band ? pts.map((p) => [p.x, p.hi]) : [],
      });
    }
    used = 'files';
  } else if (appUp) {
    const got = await runApp(fig);
    result = new Map();
    for (const s of fig.series) {
      const g = got.series.get(s.id);
      if (!g) throw new Error(`${fig.id}: no series ${s.id} in the app answer`);
      if (appFields && !String(s.ref || '').startsWith('flight:') && appFields.get(s.field) === undefined) throw new Error(`${fig.id}: the app has no field ${s.field}`);
      result.set(s.id, {points: g.points, lo: g.lo, hi: g.hi, unit: g.unit});
    }
    used = 'app';
  } else if (['app-frames', 'app-bin'].includes(r.mode) && fig.series.every((s) => !s.ref)) {
    result = new Map();
    for (const s of fig.series) {
      const base = benchSeries(fig, s);
      if (r.mode === 'app-bin') {
        const xs = base.map((p) => p[0]);
        const xmin = Math.min(...xs);
        const b = binPoints(base, r.bin, xmin);
        result.set(s.id, {
          points: b.map((p) => [p.x, p.y]),
          lo: s.band ? b.map((p) => [p.x, p.lo]) : [],
          hi: s.band ? b.map((p) => [p.x, p.hi]) : [],
        });
      } else {
        result.set(s.id, {points: base, lo: [], hi: []});
      }
    }
    used = 'files';
  } else {
    const old = prev.get(fig.id);
    if (!old) throw new Error(`${fig.id}: needs the bench app (${r.mode}) and has no earlier export to carry over`);
    usedSources.add('carried');
    console.warn(`  ${fig.id}: app down, carried over from the files on disk`);
    return old;
  }
  usedSources.add(used);

  // Mode specific post-processing, per series.
  let cutX = null;
  if (r.cutWhen) {
    const helper = result.get(r.cutWhen.series).points;
    let seenLive = false;
    for (const [x, y] of helper) {
      if (y >= 5) seenLive = true;
      if (seenLive && y < r.cutWhen.below) {
        cutX = x;
        break;
      }
    }
    if (cutX === null) throw new Error(`${fig.id}: no loss of ${r.cutWhen.series} found to cut at`);
  }
  let refMax = null;
  if (r.clipToReference) {
    const ref = fig.series.find((s) => s.role === 'reference');
    refMax = Math.max(...result.get(ref.id).points.map((p) => p[0]));
  }

  const series = [];
  for (const s of visible) {
    const g = result.get(s.id);
    let points = g.points.map((p) => [p[0], p[1]]);
    let lo = g.lo;
    let hi = g.hi;
    const bounds = [r.from ?? (r.window ? r.window[0] : null), cutX ?? (r.window ? r.window[1] : null) ?? refMax];
    if (r.mode === 'app-raw-share') {
      // Share of samples with the flag set, per distance bin of width r.bin.
      const groups = new Map();
      for (const [x, y] of points) {
        const k = Math.floor(x / r.bin);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(y > 0.5 ? 1 : 0);
      }
      points = [...groups.entries()]
        .sort((a, b) => a[0] - b[0])
        .filter(([, v]) => v.length >= r.minCount)
        .map(([k, v]) => [(k + 0.5) * r.bin, (100 * v.reduce((a, b) => a + b, 0)) / v.length]);
    }
    points = clip(points, bounds[0], bounds[1]);
    if (lo.length && hi.length) {
      lo = clip(lo.filter((p) => p[1] !== null), bounds[0], bounds[1]);
      hi = clip(hi.filter((p) => p[1] !== null), bounds[0], bounds[1]);
    }
    if (['app-frames', 'app-raw'].includes(r.mode)) points = minmax(points, r.buckets || 170);
    points.sort((a, b) => a[0] - b[0]);
    if (points.length > MAX_POINTS) points = minmax(points, MAX_POINTS / 2);
    const entry = {
      id: s.id,
      name: s.name,
      role: s.role,
      style: s.style,
      field: s.field,
      ...(s.axis === 'y2' ? {axis: 'y2'} : {}),
      points: points.map(([x, y]) => [sig4(x), sig4(y)]),
    };
    if (lo.length && hi.length && lo.length === points.length) {
      entry.band = {
        lo: lo.map(([x, y]) => [sig4(x), sig4(y)]),
        hi: hi.map(([x, y]) => [sig4(x), sig4(y)]),
      };
    } else if (lo.length && hi.length) {
      // band points follow their own x grid after clipping; keep only matching ones
      const xs = new Set(points.map((p) => sig4(p[0])));
      const l2 = lo.map(([x, y]) => [sig4(x), sig4(y)]).filter((p) => xs.has(p[0]));
      const h2 = hi.map(([x, y]) => [sig4(x), sig4(y)]).filter((p) => xs.has(p[0]));
      if (l2.length === points.length && h2.length === points.length) entry.band = {lo: l2, hi: h2};
    }
    series.push(entry);
  }

  // Pin every number the finding quotes.
  verifyChecks(fig, series);

  // Optional display unit change on x (e.g. permille to percent), applied
  // after the checks so they stay in the unit the app reports.
  if (fig.xScale) {
    const sx = (pt) => [sig4(pt[0] * fig.xScale), pt[1]];
    for (const s of series) {
      s.points = s.points.map(sx);
      if (s.band) s.band = {lo: s.band.lo.map(sx), hi: s.band.hi.map(sx)};
    }
  }

  const out = {
    id: fig.id,
    ...(fig.group ? {group: fig.group} : {}),
    product: fig.product,
    tier: fig.tier ?? null,
    title: fig.title,
    kind: fig.kind,
    featured: fig.featured,
    order: fig.order,
    blurb: fig.blurb,
    x: fig.x,
    y: fig.y,
    ...(fig.y2 ? {y2: fig.y2} : {}),
    series,
    setup: fig.setup,
    source: fig.source,
    finding: fig.finding,
    caveats: fig.caveats,
    status: fig.status,
  };
  return out;
}

function nearest(points, x) {
  let best = null;
  for (const p of points) if (best === null || Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p;
  return best;
}

function verifyChecks(fig, series) {
  const by = Object.fromEntries(series.map((s) => [s.id, s]));
  for (const c of fig.checks || []) {
    const s = by[c.series];
    if (!s) throw new Error(`${fig.id}: check names unknown series ${c.series}`);
    const p = nearest(s.points, c.x);
    if (!p || Math.abs(p[0] - c.x) > (c.xtol ?? 1e-6)) {
      throw new Error(`${fig.id}: check at x=${c.x} on ${c.series}: nearest point is ${p?.[0]}`);
    }
    if (Math.abs(p[1] - c.y) > c.tol) {
      throw new Error(`${fig.id}: check on ${c.series} at ${c.x}: expected ${c.y} +-${c.tol}, got ${p[1]}`);
    }
  }
  for (const c of fig.maxChecks || []) {
    const s = by[c.series];
    const m = Math.max(...s.points.map((p) => p[1]));
    if (Math.abs(m - c.y) > c.tol) throw new Error(`${fig.id}: maximum of ${c.series} is ${m}, expected ${c.y} +-${c.tol}`);
  }
  if (fig.ratioCheck) {
    const d = fig.ratioCheck;
    const den = new Map(by[d.den].points.map((p) => [p[0], p[1]]));
    const ratios = by[d.num].points
      .filter((p) => den.has(p[0]) && den.get(p[0]) > d.minDen)
      .map((p) => p[1] / den.get(p[0]));
    const inside = ratios.filter((r) => r >= d.within[0] && r <= d.within[1]).length;
    const got = [ratios.length, inside, +Math.min(...ratios).toFixed(2), +Math.max(...ratios).toFixed(2)];
    const want = [d.count, d.inside, d.min, d.max];
    if (got.join() !== want.join()) throw new Error(`${fig.id}: ratio check got ${got.join(', ')}, expected ${want.join(', ')}`);
  }
  if (fig.diffCheck) {
    const d = fig.diffCheck;
    const a = new Map(by[d.a].points.map((p) => [p[0], p[1]]));
    const diffs = by[d.b].points
      .filter((p) => a.has(p[0]) && p[0] >= d.from && p[0] <= d.to)
      .map((p) => a.get(p[0]) - p[1]);
    if (!diffs.length) throw new Error(`${fig.id}: diffCheck found no shared bins`);
    const lo = Math.min(...diffs);
    const hi = Math.max(...diffs);
    if (lo < d.min || hi > d.max) throw new Error(`${fig.id}: ${d.a} minus ${d.b} spans ${lo} to ${hi}, outside ${d.min} to ${d.max}`);
  }
}

// ------------------------------------------------------------- validation

function validateFigure(f, errors) {
  const bad = (m) => errors.push(`${f.id ?? '?'}: ${m}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.id)) bad('id is not kebab-case');
  if (!PRODUCTS.has(f.product)) bad(`unknown product ${f.product}`);
  if (f.tier !== null && !TIERS.has(f.tier)) bad(`bad tier ${f.tier}`);
  if (!KINDS.has(f.kind)) bad(`bad kind ${f.kind}`);
  if (!STATUSES.has(f.status)) bad(`bad status ${f.status}`);
  for (const ax of ['x', 'y', ...(f.y2 ? ['y2'] : [])]) {
    if (!f[ax]?.label || !f[ax]?.unit) bad(`axis ${ax} needs a label and a unit`);
    if (!['linear', 'log'].includes(f[ax]?.scale)) bad(`axis ${ax} scale`);
  }
  if (!f.series?.length) bad('no series');
  for (const s of f.series || []) {
    if (!ROLES.has(s.role)) bad(`series ${s.id}: role`);
    if (!STYLES.has(s.style)) bad(`series ${s.id}: style`);
    if (!s.name) bad(`series ${s.id}: name`);
    if (!s.points?.length) bad(`series ${s.id}: no points`);
    if (s.points?.length > MAX_POINTS) bad(`series ${s.id}: ${s.points.length} points, cap ${MAX_POINTS}`);
    let last = -Infinity;
    for (const p of s.points || []) {
      if (!(Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]))) bad(`series ${s.id}: non-finite point`);
      if (p[0] < last) bad(`series ${s.id}: x not ascending`);
      last = p[0];
    }
    if (s.band && (s.band.lo.length !== s.points.length || s.band.hi.length !== s.points.length)) {
      bad(`series ${s.id}: band does not match points`);
    }
    if (THRUST_STAND_RUN.test(f.source?.run || '') && !THRUST_STAND_FIELDS.has(s.field)) {
      bad(`series ${s.id}: field ${s.field} not allowed on a thrust stand run`);
    }
  }
  if (!f.setup || !f.finding || !f.caveats?.length) bad('setup, finding and caveats are required');
  const src = f.source || {};
  if (!src.run || !SOURCE_KINDS.has(src.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(src.recorded || '') || !src.reduction) {
    bad('source needs run, kind, recorded and reduction');
  }
  if (src.simulated !== false) bad('source.simulated must be false');
  if (THRUST_STAND_RUN.test(src.run || '') && /\b(current|power|efficiency|g\/W)\b/i.test(JSON.stringify([f.title, f.finding, f.setup, f.caveats, f.y]).replace(/clamp meter was not recorded/i, '').replace(/no current/i, ''))) {
    bad('a thrust stand figure mentions current, power or efficiency');
  }
}

function validateTimeline(items, figureIds, errors) {
  const ids = new Set();
  for (const t of items) {
    const bad = (m) => errors.push(`timeline ${t.id}: ${m}`);
    if (ids.has(t.id)) bad('duplicate id');
    ids.add(t.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) bad('date');
    if (!PRODUCTS.has(t.product)) bad('product');
    if (!t.tested || !t.saw) bad('tested and saw are required');
    if (t.changed !== null && typeof t.changed !== 'string') bad('changed must be text or null');
    if (t.figureId && !figureIds.has(t.figureId)) bad(`figureId ${t.figureId} does not exist`);
    if (t.commit && !/^[0-9a-f]{7,40}$/.test(t.commit)) bad('commit');
    if (!STATUSES.has(t.status)) bad('status');
  }
}

/** Walk every string and key; report the path of the first banned hit. */
function scan(value, where, hits) {
  if (typeof value === 'string') {
    for (const [re, why] of BANNED_TEXT) if (re.test(value)) hits.push(`${where}: ${why}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${where}[${i}]`, hits));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (STRIP_KEYS.has(k)) hits.push(`${where}.${k}: field that must be stripped`);
      scan(v, `${where}.${k}`, hits);
    }
  }
}

// -------------------------------------------------------------------- main

function sourceRevision() {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', '--short=7', 'HEAD'], {encoding: 'utf8'}).trim();
  } catch {
    return 'unknown';
  }
}

/** Two-space JSON with number pairs kept on one line, so a point is one line. */
const pretty = (o) =>
  JSON.stringify(o, null, 2).replace(/\[\s*(-?[\d.e+-]+),\s*(-?[\d.e+-]+)\s*\]/g, '[$1, $2]') + '\n';

async function main() {
  const appUp = await probeApp();
  console.log(`bench app: ${appUp ? API : 'not reachable'}${OFFLINE ? ' (--offline)' : ''}; captures: ${REPO}`);
  if (!appUp && !fs.existsSync(path.join(REPO, 'Logs'))) {
    // Nothing to read: only the scan can run.
    if (mode === 'write') throw new Error('neither the bench app nor the capture files are available');
    console.warn('no source available: scanning the files on disk only');
    return scanDisk();
  }

  const figures = [];
  for (const fig of cfg.figures) {
    console.log(`figure ${fig.id}`);
    figures.push(await buildFigure(fig, appUp));
  }
  figures.sort((a, b) => a.product.localeCompare(b.product) || a.order - b.order);

  const errors = [];
  const seen = new Set();
  const featured = new Map();
  for (const f of figures) {
    if (seen.has(f.id)) errors.push(`${f.id}: duplicate id`);
    seen.add(f.id);
    validateFigure(f, errors);
    if (f.featured && f.status === 'publish') featured.set(f.product, (featured.get(f.product) || 0) + 1);
  }
  for (const [p, n] of featured) if (n > 1) errors.push(`${p}: ${n} featured figures`);
  const timeline = [...cfg.timeline].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  validateTimeline(timeline, seen, errors);

  const meta = {
    generated: new Date().toISOString().slice(0, 10),
    sourceRevision: sourceRevision(),
    schema: 1,
    source: usedSources.has('carried') ? 'mixed' : appUp ? 'app' : 'file-fallback',
  };
  // Only publish items reach the committed files. Held items stay in a
  // git-ignored file so they are not bundled into the public client JS.
  const outFigures = {schema: 1, figures: figures.filter((f) => f.status === 'publish')};
  const outTimeline = {schema: 1, items: timeline.filter((t) => t.status === 'publish')};
  const held = {
    schema: 1,
    figures: figures.filter((f) => f.status !== 'publish'),
    items: timeline.filter((t) => t.status !== 'publish'),
  };

  const hits = [];
  scan(outFigures, 'figures', hits);
  scan(outTimeline, 'timeline', hits);
  if (hits.length || errors.length) {
    for (const h of hits) console.error(`banned: ${h}`);
    for (const e of errors) console.error(`invalid: ${e}`);
    process.exit(1);
  }

  const next = {'figures.json': pretty(outFigures), 'timeline.json': pretty(outTimeline), 'meta.json': pretty(meta)};
  for (const [name, text] of Object.entries(next)) {
    const kb = (Buffer.byteLength(text) / 1024).toFixed(1);
    console.log(`  ${name}: ${kb} KB`);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      console.error(`${name} is over ${MAX_FILE_BYTES / 1024} KB`);
      process.exit(1);
    }
  }

  if (mode === 'write') {
    fs.mkdirSync(OUT_DIR, {recursive: true});
    for (const [name, text] of Object.entries(next)) fs.writeFileSync(path.join(OUT_DIR, name), text);
    fs.mkdirSync(path.dirname(HELD_FILE), {recursive: true});
    fs.writeFileSync(HELD_FILE, pretty(held));
    console.log(`wrote ${Object.keys(next).length} files to content/testing (source: ${meta.source})`);
    return;
  }
  // --check: meta.generated always moves, so compare figures and timeline only.
  let drift = false;
  for (const name of ['figures.json', 'timeline.json']) {
    let disk = '';
    try {
      disk = fs.readFileSync(path.join(OUT_DIR, name), 'utf8');
    } catch {
      /* missing counts as drift */
    }
    if (disk !== next[name]) {
      drift = true;
      console.error(`DRIFT: ${name} differs from the export`);
    }
  }
  if (drift) process.exit(1);
  scanDisk();
  console.log('content/testing is in sync');
}

/** --check without a source: the banned-pattern scan over what is on disk. */
function scanDisk() {
  const hits = [];
  for (const name of fs.readdirSync(OUT_DIR)) {
    const text = fs.readFileSync(path.join(OUT_DIR, name), 'utf8');
    scan(JSON.parse(text), name, hits);
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) hits.push(`${name}: over ${MAX_FILE_BYTES / 1024} KB`);
  }
  if (hits.length) {
    for (const h of hits) console.error(`banned: ${h}`);
    process.exit(1);
  }
  console.log('content/testing: no banned strings');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
