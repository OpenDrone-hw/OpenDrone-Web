/**
 * Pure parts of scripts/sync-testing.mjs: the honesty gate, the statistics
 * that pin a finding's numbers, the reductions that run on this side of the
 * bench app, and the figure and index builders.
 *
 * Nothing here talks to the network. The CLI fetches the app's answer for a
 * view and hands it in, so the gate and the builders are testable against
 * fixtures (app/lib/testing-sync.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

// ------------------------------------------------------------------ constants

export const STATUSES = new Set(['publish', 'needs-review', 'draft']);
export const KINDS = new Set(['trace', 'frames', 'hold']);
export const QUANTITIES = new Set(['current', 'voltage', 'temperature', 'rpm', 'command', 'aux', 'thrust']);
export const STRIP_KEYS = new Set(['raw_points', 'raw_count', 'cites', 'color', 'width', 'operator', 'by', 'at', 'sources', 'notes', 'measurements']);

const AGENT_NAME = /\b(agent|claude|codex|gpt|assistant|bot|script|ai)\b/i;
const STAND_TEXT = /\b(current|power|efficiency|g\/W)\b/i;

export const finite = (v) => typeof v === 'number' && Number.isFinite(v);
export const sig5 = (v) => (v === 0 ? 0 : Number(Number(v).toPrecision(5)));
export const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function quantile(a, q) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// ------------------------------------------------------------------ config

/** Compile the banned list and the thrust stand rules once. */
export function compileConfig(cfg) {
  return {
    ...cfg,
    bannedRe: cfg.banned.map(([source, why]) => [new RegExp(source), why]),
    stand: {
      run: new RegExp(cfg.thrustStand.runPattern),
      fields: new Set(cfg.thrustStand.fields),
      bannedField: new RegExp(cfg.thrustStand.bannedFieldPattern, 'i'),
    },
  };
}

// ------------------------------------------------------------------ the gate

/** Walk every string and key; collect the path of each banned hit. */
export function scan(value, where, hits, cfg) {
  if (typeof value === 'string') {
    for (const [re, why] of cfg.bannedRe) if (re.test(value)) hits.push(`${where}: ${why}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scan(v, `${where}[${i}]`, hits, cfg));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (STRIP_KEYS.has(k)) hits.push(`${where}.${k}: field that must be stripped`);
      scan(v, `${where}.${k}`, hits, cfg);
    }
  }
}

/** The recording a ref names: `log:<folder>` is a bench capture. */
export const runOfRef = (ref) => (String(ref).startsWith('log:') ? String(ref).slice(4) : null);

/** Thrust stand fields: only what its calibrated channels can say. */
export function standViolations(view, cfg) {
  const sources = (view.sources || []).filter((s) => s.enabled !== false);
  const stand = sources.some((s) => cfg.stand.run.test(runOfRef(s.ref) || ''));
  if (!stand) return {stand: false, errors: []};
  const errors = [];
  const names = [view.x?.field, ...(view.series || []).filter((s) => s.visible !== false).map((s) => s.field)];
  for (const f of names) {
    if (!f) continue;
    if (!cfg.stand.fields.has(f) || cfg.stand.bannedField.test(f)) {
      errors.push(`a thrust stand run may not export ${f}`);
    }
  }
  return {stand: true, errors};
}

/** Every text field a visitor reads, for the stand text rule. */
function visibleText(P, labels) {
  return [P.title, P.finding, P.setup_chip, ...(P.setup || []), ...(P.caveats || []), ...labels].join('\n');
}

/** Validate a publish block beyond what the bench server checks. */
export function validatePublish(view, cfg) {
  const errors = [];
  const bad = (m) => errors.push(m);
  const P = view.publish;
  if (!P || typeof P !== 'object') return ['no publish block'];
  if (!STATUSES.has(P.status)) bad(`bad status ${P.status}`);
  if (!cfg.products[P.product]) bad(`unknown product ${P.product}`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(view.id || '')) bad('id is not kebab-case');
  if (!/^[a-z0-9]+(-[a-z0-9.]+)*$/.test(P.run || '')) bad('run is missing or not kebab-case');
  if (!cfg.domains.includes(P.domain)) bad(`domain must be one of ${cfg.domains.join(', ')}`);
  if (P.tier !== undefined && !cfg.tiers.includes(P.tier)) bad(`bad tier ${P.tier}`);
  const t = words(P.title || '');
  if (t < 3 || t > 6) bad(`title is ${t} words, wanted 3 to 6`);
  if (!String(P.finding || '').trim()) bad('finding is empty');
  else if (words(P.finding) > 25) bad(`finding is ${words(P.finding)} words, limit 25`);
  if (!Array.isArray(P.setup) || !P.setup.some((x) => String(x).trim())) bad('setup is empty');
  if (!String(P.setup_chip || '').trim()) bad('setup_chip is empty');
  if (!Array.isArray(P.caveats) || !P.caveats.length) bad('caveats are empty');
  if (!Number.isFinite(P.order)) bad('order must be a number');
  if (P.status === 'publish') {
    if (!String(P.by || '').trim() || !/^\d{4}-\d{2}-\d{2}/.test(String(P.at || ''))) bad('by and at are required to publish');
    if (AGENT_NAME.test(P.by || '')) bad('by names an agent; only a person publishes');
    if (/\d/.test(P.finding || '') && !(P.checks || []).length) bad('the finding quotes numbers and no check pins them');
  }
  for (const s of view.sources || []) {
    if (/Private\//i.test(s.ref || '')) bad(`source ${s.ref} is under the private tree`);
  }
  const stand = standViolations(view, cfg);
  for (const e of stand.errors) bad(e);
  if (stand.stand) {
    const labels = Object.values(P.series || {}).map((s) => s.label || '');
    const axes = Object.values(P.axes || {}).map((a) => a.label || '');
    const text = visibleText(P, [...labels, ...axes]);
    if (STAND_TEXT.test(text)) bad('a thrust stand figure mentions current, power or efficiency');
  }
  return errors;
}

// ------------------------------------------------------------------ reductions

/**
 * Min and max per x bucket: both extremes of every bucket survive, so a spike
 * is never lost the way every-nth-point thinning loses it. Points must be
 * sorted by x. A point with no reading stays where it is: a gap is not drawn
 * across and is not filled.
 */
export function decimate(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const nulls = points.filter((p) => p.y === null);
  const live = points.filter((p) => p.y !== null);
  const buckets = Math.max(1, Math.floor((maxPoints - 2 - nulls.length) / 2));
  const x0 = live[0].x;
  const w = (live[live.length - 1].x - x0) / buckets || 1;
  const bins = new Map();
  for (const p of live) {
    const k = Math.min(buckets - 1, Math.floor((p.x - x0) / w));
    const b = bins.get(k);
    if (!b) bins.set(k, {lo: p, hi: p});
    else {
      if (p.y < b.lo.y) b.lo = p;
      if (p.y > b.hi.y) b.hi = p;
    }
  }
  const keep = new Set([live[0], live[live.length - 1]]);
  for (const b of bins.values()) {
    keep.add(b.lo);
    keep.add(b.hi);
  }
  return [...live.filter((p) => keep.has(p)), ...nulls].sort((a, b) => a.x - b.x);
}

/**
 * Frames that share one x. Rotor speed telemetry updates far slower than the
 * load cell samples, so the same rpm value is paired with many thrust samples
 * and a line through them is a sawtooth that no motor produced. Points must be
 * sorted by x; each run of equal x becomes one point at the median y.
 */
export function collapseSameX(points) {
  const out = [];
  let i = 0;
  while (i < points.length) {
    let j = i;
    while (j + 1 < points.length && points[j + 1].x === points[i].x) j++;
    if (j === i) out.push(points[i]);
    else {
      const ys = points.slice(i, j + 1).map((p) => p.y).filter((v) => v !== null);
      out.push({...points[i], y: ys.length ? median(ys) : null});
    }
    i = j + 1;
  }
  return out;
}

/** Share of samples with the flag set, per x bin of width `bin`. */
export function shareByBin(points, bin, minCount) {
  const groups = new Map();
  for (const p of points) {
    if (p.y === null) continue;
    const k = Math.floor(p.x / bin);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p.y > 0.5 ? 1 : 0);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.length >= minCount)
    .map(([k, v]) => ({x: (k + 0.5) * bin, y: (100 * v.reduce((a, b) => a + b, 0)) / v.length, n: v.length}));
}

// ------------------------------------------------------------------ capture files

/**
 * The thrust stand holds. The app's own hold reduction needs a current clamp,
 * which that stand does not have, so these are computed here from the capture:
 * the median of the last N seconds of each constant-throttle segment.
 */
export function loadBench(dataRoot, run) {
  let dir = null;
  for (const d of [path.join(dataRoot, 'Logs', run), path.join(dataRoot, 'Logs', '_archive', run)]) {
    if (fs.existsSync(path.join(d, 'bench.csv'))) {
      dir = d;
      break;
    }
  }
  if (!dir) throw new Error(`capture ${run}: no bench.csv under ${dataRoot}/Logs`);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  if (manifest.simulated === true || (manifest.instruments || []).some((i) => i.simulated === true)) {
    throw new Error(`${run}: the manifest marks this capture simulated`);
  }
  const all = fs.readFileSync(path.join(dir, 'bench.csv'), 'utf8').split('\n');
  const keep = [];
  all.forEach((l, i) => {
    if (l && !l.startsWith('#')) keep.push([i + 1, l]);
  });
  const head = keep[0][1].split(',');
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const rows = keep.slice(1).map(([line, l]) => {
    const c = l.split(',');
    const num = (name) => {
      const i = col[name];
      if (i === undefined || c[i] === '' || c[i] === undefined) return null;
      const v = Number(c[i]);
      return Number.isFinite(v) ? v : null;
    };
    return {num, line};
  });
  const t0 = rows.length ? rows[0].num('t_ms') : 0;
  return {rows, t0, poles: manifest.motor_poles || manifest.poles || 14, folder: path.relative(dataRoot, dir)};
}

function benchField(bench, row, field, motor) {
  switch (field) {
    case 't':
      return (row.num('t_ms') - bench.t0) / 1000;
    case 'thr':
      return row.num(`thr${motor}`);
    case 'rpm': {
      const e = row.num(`erpm${motor}`);
      return e === null ? null : e / (bench.poles / 2);
    }
    case 'v_bus':
      return row.num('v_v');
    case 'thrust_g':
      return row.num('thrust_g');
    case 'tesc_max': {
      const v = [1, 2, 3, 4].map((m) => row.num(`tesc${m}`)).filter(finite);
      return v.length ? Math.max(...v) : null;
    }
    default:
      throw new Error(`no capture-file reduction for field ${field}`);
  }
}

/** Constant-throttle segments (5 permille, minMs), the app's own rule. */
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

/** One entry per hold: median x and y of the last `seconds`, the quartiles of y. */
export function holdLast(bench, params, xField, yField) {
  const motor = params.motor ?? 1;
  const out = [];
  for (const [a, b] of dwells(bench, motor, params.minDwellMs)) {
    const thr = median(bench.rows.slice(a, b + 1).map((row) => row.num(`thr${motor}`)));
    if (!(thr > params.drivenThrAbove)) continue;
    const tEnd = bench.rows[b].num('t_ms');
    const win = bench.rows.slice(a, b + 1).filter((row) => row.num('t_ms') > tEnd - params.seconds * 1000);
    const bus = median(win.map((row) => benchField(bench, row, 'v_bus', motor)).filter(finite));
    if (params.dropBelowBusV !== undefined && !(bus >= params.dropBelowBusV)) continue;
    const xs = win.map((row) => benchField(bench, row, xField, motor)).filter(finite);
    const ys = win.map((row) => benchField(bench, row, yField, motor)).filter(finite);
    if (!xs.length || !ys.length) continue;
    out.push({
      x: median(xs),
      y: median(ys),
      lo: quantile(ys, 0.25),
      hi: quantile(ys, 0.75),
      n: ys.length,
      thr,
      t0: (win[0].num('t_ms') - bench.t0) / 1000,
      t1: (win[win.length - 1].num('t_ms') - bench.t0) / 1000,
      l0: win[0].line,
      l1: win[win.length - 1].line,
    });
  }
  return out;
}

// ------------------------------------------------------------------ checks

/** y values of a series that are readings, with their x. */
const live = (s) => s.x.map((x, i) => [x, s.y[i]]).filter((p) => p[1] !== null);

/** The shared x of two series as [x, a, b] triples. */
function shared(a, b) {
  const other = new Map(live(b).map((p) => [p[0], p[1]]));
  return live(a).filter((p) => other.has(p[0])).map((p) => [p[0], p[1], other.get(p[0])]);
}

/** The number a check pins, from the series as published. */
export function statOf(c, by) {
  const s = by[c.series];
  if (!s) throw new Error(`names unknown series ${c.series}`);
  const inRange = (x) => (c.from === undefined || x >= c.from) && (c.to === undefined || x <= c.to);
  switch (c.stat) {
    case 'at': {
      let best = null;
      for (const p of live(s)) if (best === null || Math.abs(p[0] - c.x) < Math.abs(best[0] - c.x)) best = p;
      if (!best || Math.abs(best[0] - c.x) > (c.xtol ?? 1e-6)) {
        throw new Error(`no reading within ${c.xtol ?? 1e-6} of x=${c.x} on ${c.series} (nearest ${best?.[0]})`);
      }
      return best[1];
    }
    case 'first':
      return live(s)[0]?.[1];
    case 'max':
      return Math.max(...live(s).filter((p) => inRange(p[0])).map((p) => p[1]));
    case 'min':
      return Math.min(...live(s).filter((p) => inRange(p[0])).map((p) => p[1]));
    case 'slope': {
      const pts = live(s).filter((p) => inRange(p[0]));
      const n = pts.length;
      const mx = pts.reduce((a, p) => a + p[0], 0) / n;
      const my = pts.reduce((a, p) => a + p[1], 0) / n;
      const num = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
      const den = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
      return num / den;
    }
    case 'quad': {
      // y per (x / 1000) squared, the coefficient of a quadratic law, median over the range.
      const v = live(s).filter((p) => inRange(p[0]) && p[0] > 0).map((p) => p[1] / (p[0] / 1000) ** 2);
      return median(v);
    }
    case 'diff':
    case 'ratio': {
      const other = by[c.with];
      if (!other) throw new Error(`names unknown series ${c.with}`);
      let rows = shared(s, other).filter((p) => inRange(p[0]));
      let v;
      if (c.stat === 'diff') v = rows.map((p) => p[1] - p[2]);
      else {
        rows = rows.filter((p) => p[2] > (c.minDen ?? 0));
        v = rows.map((p) => p[1] / p[2]);
      }
      switch (c.metric) {
        case 'n':
          return v.length;
        case 'below':
          return v.filter((d) => d < 0).length;
        case 'above':
          return v.filter((d) => d > 0).length;
        case 'inside':
          return v.filter((d) => d >= c.within[0] && d <= c.within[1]).length;
        case 'median':
          return median(v);
        case 'min':
          return Math.min(...v);
        case 'max':
          return Math.max(...v);
        default:
          throw new Error(`unknown metric ${c.metric}`);
      }
    }
    default:
      throw new Error(`unknown stat ${c.stat}`);
  }
}

export function runChecks(checks, by) {
  const errors = [];
  for (const c of checks || []) {
    const label = `check ${c.stat}${c.metric ? '.' + c.metric : ''} on ${c.series}`;
    try {
      const v = statOf(c, by);
      if (!(typeof v === 'number' && v >= c.min && v <= c.max)) {
        errors.push(`${label}: got ${v}, expected ${c.min} to ${c.max}`);
      }
    } catch (e) {
      errors.push(`${label}: ${e.message}`);
    }
  }
  return errors;
}

// ------------------------------------------------------------------ the figure

/** Quantity (and so the hue) of a field, unless the block says otherwise. */
export function quantityOf(field) {
  if (field === 'thrust_g') return 'thrust';
  if (/^(rpm|erpm)\d?$/.test(field)) return 'rpm';
  if (/^thr\d?$/.test(field)) return 'command';
  if (/^(v_|ch\d)/.test(field)) return 'voltage';
  if (/^(i_|i1$|curr|amp)/i.test(field)) return 'current';
  if (/(^tesc|etemp|^t_ntc|temp)/i.test(field)) return 'temperature';
  return 'aux';
}

/** The app's points for one series, with the band's quartiles attached by x. */
const asPoints = (s) => {
  const at = (arr) => new Map((arr || []).map((p) => [p[0], p[1]]));
  const lo = at(s.band?.lo);
  const hi = at(s.band?.hi);
  return (s.points || [])
    .filter((p) => finite(p[0]))
    .map((p) => ({
      x: p[0],
      y: finite(p[1]) ? p[1] : null,
      lo: finite(lo.get(p[0])) ? lo.get(p[0]) : null,
      hi: finite(hi.get(p[0])) ? hi.get(p[0]) : null,
    }));
};

/** The ref for one view series, to name the recording it came from. */
const refOf = (view, series) => (view.sources || []).find((s) => s.id === series.source)?.ref || '';

const clip = (pts, lo, hi) =>
  pts.filter((p) => (lo === null || lo === undefined || p.x >= lo) && (hi === null || hi === undefined || p.x <= hi));

/** Group citations by recording and join them as `Logs/<folder>#La-Lb`. */
export function citeOf(citations) {
  const groups = new Map();
  for (const c of citations || []) {
    const key = c.folder || c.ref;
    const g = groups.get(key) || {ref: c.ref, l0: null, l1: null, folder: c.folder};
    if (c.l0 > 0 && c.l1 > 0) {
      g.l0 = g.l0 === null ? c.l0 : Math.min(g.l0, c.l0);
      g.l1 = g.l1 === null ? c.l1 : Math.max(g.l1, c.l1);
    }
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => (g.l0 ? `${g.folder}#L${g.l0}-L${g.l1}` : String(g.ref).replace(/\s*\(.*$/, ''))).join('; ');
}

/**
 * Build the public figure for one view from the app's answer.
 *
 * `resp` is the body of POST /api/numbers/figure for the view's spec.
 * `benches` maps a run folder to loadBench() output, for the stand holds.
 * Returns {fig, errors, run, notes}: errors are gate failures, notes are facts
 * for the log.
 */
const axesYUnit = (P) => (P.axes?.y?.unit === 'g' ? 'g' : P.axes?.y?.unit || '');
const axesXUnit = (P) => (P.axes?.x?.unit === 'rpm' ? 'krpm' : P.axes?.x?.unit || '');

export function buildFigure(view, resp, benches, cfg) {
  const P = view.publish;
  const errors = validatePublish(view, cfg).map((m) => `${view.id}: ${m}`);
  const bad = (m) => errors.push(`${view.id}: ${m}`);
  if (resp.simulated === true) bad('the app reports a simulated capture');

  const drawn = (view.series || []).filter((s) => s.visible !== false);
  if (!Array.isArray(resp.series) || resp.series.length !== drawn.length) {
    bad(`the app returned ${resp.series?.length} series, expected ${drawn.length}`);
    return {fig: null, errors};
  }
  const hide = new Set(P.hide || []);
  const display = P.display || {};
  const holds = P.holds || null;
  const byApp = new Map(drawn.map((s, i) => [s.id, resp.series[i]]));
  const raw = new Map(); // series id -> points
  for (const s of drawn) raw.set(s.id, asPoints(byApp.get(s.id)));

  // Bounds for the visible window, from the display block.
  let cutX = null;
  if (display.cutWhen) {
    let seen = false;
    for (const p of raw.get(display.cutWhen.series) || []) {
      if (p.y !== null && p.y >= 5) seen = true;
      if (seen && p.y !== null && p.y < display.cutWhen.below) {
        cutX = p.x;
        break;
      }
    }
    if (cutX === null) bad(`no loss of ${display.cutWhen.series} found to cut at`);
  }
  let refMax = null;
  if (display.clipToReference) {
    const ref = raw.get(display.clipToReference) || [];
    refMax = ref.length ? Math.max(...ref.map((p) => p.x)) : null;
  }
  const lo = display.from ?? display.window?.[0] ?? null;
  const hi = cutX ?? display.window?.[1] ?? refMax;

  const kindOfApi = view.reduce === 'hold' ? 'hold' : holds && holds.frames !== false ? 'frames' : 'trace';
  const out = [];
  const xs = display.xScale ?? 1;
  const scaleX = (pts) => pts.map((p) => ({...p, x: p.x * xs}));
  const entry = (id, label, quantity, pack, kind, axis, pts, band) => {
    const e = {
      id,
      label,
      quantity,
      ...(pack ? {pack} : {}),
      kind,
      ...(axis === 'right' ? {axis: 'y2'} : {}),
      x: pts.map((p) => sig5(p.x)),
      y: pts.map((p) => (p.y === null ? null : sig5(p.y))),
    };
    if (band && pts.some((p) => p.lo !== null && p.hi !== null)) {
      e.lo = pts.map((p) => (p.lo === null ? null : sig5(p.lo)));
      e.hi = pts.map((p) => (p.hi === null ? null : sig5(p.hi)));
    }
    return e;
  };

  const needFrames = !holds || holds.frames !== false;
  for (const s of drawn) {
    if (hide.has(s.id)) continue;
    const meta = P.series?.[s.id] || {};
    let pts = raw.get(s.id);
    if (display.share) pts = shareByBin(pts, display.share.bin, display.share.minCount);
    pts = clip(pts, lo, hi).sort((a, b) => a.x - b.x);
    if (kindOfApi === 'frames') pts = collapseSameX(pts);
    if (kindOfApi !== 'hold' && !s.band) pts = decimate(pts, cfg.maxPoints);
    if (!needFrames && kindOfApi !== 'hold') continue;
    const base = meta.label || s.name || s.id;
    const suffix = kindOfApi === 'frames' ? ', frames' : kindOfApi === 'hold' ? ', hold median' : '';
    out.push(
      entry(s.id, base + suffix, meta.quantity || quantityOf(s.field), meta.pack, kindOfApi, s.axis, scaleX(pts), !!s.band),
    );
  }

  // Stand holds from the capture files.
  const holdRecords = [];
  const holdCites = [];
  const fitPts = [];
  if (holds) {
    for (const s of drawn) {
      if (hide.has(s.id)) continue;
      const run = runOfRef(refOf(view, s));
      const bench = run ? benches.get(run) : null;
      if (!bench) {
        bad(`series ${s.id}: holds need a bench capture, not ${refOf(view, s)}`);
        continue;
      }
      const meta = P.series?.[s.id] || {};
      let got;
      try {
        got = holdLast(bench, holds, view.x.field, s.field);
      } catch (e) {
        bad(`series ${s.id}: ${e.message}`);
        continue;
      }
      const pts = got.sort((a, b) => a.x - b.x).map((h) => ({x: h.x, y: h.y, lo: holds.band ? h.lo : null, hi: holds.band ? h.hi : null}));
      if (!pts.length) bad(`series ${s.id}: no holds found in ${run}`);
      out.push(
        entry(`${s.id}.hold`, `${meta.label || s.name || s.id}, hold median, last ${holds.seconds} s`, meta.quantity || quantityOf(s.field), meta.pack, 'hold', s.axis, scaleX(pts), true),
      );
      for (const h of got) {
        if (P.fit && h.thr / 10 >= P.fit.fromThrottle) fitPts.push([h.x * xs, h.y]);
        if (!holdRecords.some((r) => r.run === (meta.pack || run) && r.t0 === sig5(h.t0))) {
          holdRecords.push({run: meta.pack || run, throttle: sig5(h.thr / 10), t0: sig5(h.t0), t1: sig5(h.t1), n: h.n});
        }
      }
      if (got.length) holdCites.push(`${bench.folder}#L${Math.min(...got.map((h) => h.l0))}-L${Math.max(...got.map((h) => h.l1))}`);
    }
  }

  // Quadratic law y = k (x / 1000)^2 through the origin, least squares over the
  // holds at or above a throttle, both runs pooled. Published with its range and
  // its largest miss, so the page can draw it and the claim can be checked.
  let fit = null;
  if (P.fit && fitPts.length >= 3) {
    const u = fitPts.map(([x, y]) => [x / 1000, y]);
    const k = u.reduce((a, [x, y]) => a + x * x * y, 0) / u.reduce((a, [x]) => a + x ** 4, 0);
    const miss = Math.max(...u.map(([x, y]) => Math.abs(y - k * x * x)));
    fit = {
      k: Number(k.toPrecision(3)),
      unit: `${axesYUnit(P)} per ${axesXUnit(P)} squared`,
      fromThrottle: P.fit.fromThrottle,
      x0: sig5(Math.min(...fitPts.map((p) => p[0]))),
      x1: sig5(Math.max(...fitPts.map((p) => p[0]))),
      maxMiss: Number(miss.toPrecision(2)),
      n: fitPts.length,
    };
  }

  // Checks run on the numbers as published.
  const by = Object.fromEntries(out.map((e) => [e.id, e]));
  for (const s of drawn) {
    if (hide.has(s.id)) by[s.id] = {id: s.id, x: raw.get(s.id).map((p) => p.x * xs), y: raw.get(s.id).map((p) => p.y)};
  }
  for (const m of runChecks(P.checks, by)) bad(m);

  // Axes: the app's own labels and units, overridden by the block.
  const left = resp.axes?.left || {};
  const right = resp.axes?.right || null;
  const axes = {
    x: {label: resp.x?.label || view.x.field, unit: resp.x?.unit || '', ...(P.axes?.x || {})},
    y: {label: left.label || '', unit: left.unit || '', ...(P.axes?.y || {})},
  };
  if (right || P.axes?.y2) axes.y2 = {label: right?.label || '', unit: right?.unit || '', ...(P.axes?.y2 || {})};
  for (const k of Object.keys(axes)) if (!axes[k].label || !axes[k].unit) bad(`axis ${k} needs a label and a unit`);

  // Series sanity.
  if (!out.length) bad('no series');
  for (const s of out) {
    if (!QUANTITIES.has(s.quantity)) bad(`series ${s.id}: unknown quantity ${s.quantity}`);
    if (!s.x.length) bad(`series ${s.id}: no points`);
    if (s.x.length > cfg.maxPoints) bad(`series ${s.id}: ${s.x.length} points, cap ${cfg.maxPoints}`);
    for (let i = 1; i < s.x.length; i++) if (s.x[i] < s.x[i - 1]) { bad(`series ${s.id}: x not ascending`); break; }
  }

  const reduction = [];
  if (view.reduce === 'hold') reduction.push('Median over the settled window of each throttle hold; the band is the 25th to 75th percentile.');
  else if (view.reduce?.bin) reduction.push(`Median in ${view.reduce.bin} ${axes.x.unit} bins; the band is the 25th to 75th percentile.`);
  else if (view.reduce === 'sweep') reduction.push('Sweep bins of mechanical speed; up and down legs averaged in each bin.');
  else if (display.share) reduction.push(`Share of logged samples with the flag set, in ${display.share.bin} ${axes.x.unit} bins of at least ${display.share.minCount} samples.`);
  else if (display.window) reduction.push(`Logged values from ${display.window[0]} s to ${display.window[1]} s.`);
  else reduction.push(view.reduce === 'frames' ? 'Logged frames; frames in throttle or speed transients are excluded.' : 'Logged values, unreduced.');
  if (kindOfApi === 'frames' && holds) reduction.push('Frames that share one rotor speed reading are reduced to their median, because rotor speed telemetry updates slower than the load cell.');
  if (holds) reduction.push(`Hold markers: median of the last ${holds.seconds} s of each throttle hold; the band is the 25th to 75th percentile. Holds with no pack voltage reading are dropped.`);
  if (display.from !== undefined || display.cutWhen) reduction.push(`Shown from ${display.from ?? 0} s${cutX !== null ? ' to the loss of bus voltage telemetry' : ''}.`);
  if (out.some((s) => s.kind !== 'hold' && s.x.length > cfg.maxPoints * 0.98)) reduction.push(`Over ${cfg.maxPoints} points are thinned to the minimum and maximum of each x bucket.`);

  const recorded = (resp.provenance?.sources || []).map((s) => String(s.recorded || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!recorded.length) bad('no recording date in the app answer');

  const cite = needFrames ? citeOf(resp.citations) : [...new Set(holdCites)].join('; ');
  const fig = {
    id: view.id,
    title: P.title,
    finding: P.finding,
    product: P.product,
    tier: P.tier ?? null,
    runId: P.run,
    domain: P.domain,
    chip: P.setup_chip,
    caveats: P.caveats.map((c) => (c.startsWith('!') ? {text: c.slice(1).trim(), flag: true} : {text: c})),
    reduction: reduction.join(' '),
    cite,
    axes,
    series: out,
    holds: holdRecords,
    ...(fit ? {fit} : {}),
  };

  const hits = [];
  scan(fig, view.id, hits, cfg);
  scan(P.setup, `${view.id}.setup`, hits, cfg);
  for (const h of hits) errors.push(`banned: ${h}`);

  return {
    fig: errors.length ? null : fig,
    errors,
    run: {id: P.run, date: recorded[0] || null, setup: P.setup, chip: P.setup_chip},
    meta: {status: P.status, order: P.order, featured: !!P.featured, tier: P.tier ?? null, product: P.product},
    fullFig: fig,
  };
}

// ------------------------------------------------------------------ index and log

export function validateLog(items, publishedIds, cfg) {
  const errors = [];
  const ids = new Set();
  for (const t of items) {
    const bad = (m) => errors.push(`log ${t.id}: ${m}`);
    if (ids.has(t.id)) bad('duplicate id');
    ids.add(t.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) bad('date');
    if (!cfg.products[t.product]) bad('product');
    if (!t.tested || !t.saw) bad('tested and saw are required');
    if (t.changed !== null && typeof t.changed !== 'string') bad('changed must be text or null');
    if (t.figureId && !publishedIds.has(t.figureId)) bad(`figureId ${t.figureId} is not a published figure`);
    if (t.commit && !/^[0-9a-f]{7,40}$/.test(t.commit)) bad('commit');
    if (!STATUSES.has(t.status)) bad('status');
  }
  return errors;
}

/**
 * The index: products with their figure ids, the run table, the log, and a
 * summary line per figure so a card can be drawn without fetching the figure.
 * Figures of one run must agree on the setup they share.
 */
export function buildIndex(built, logItems, cfg, builtAt) {
  const errors = [];
  const runs = {};
  for (const b of built) {
    const r = b.run;
    const prev = runs[r.id];
    if (!prev) runs[r.id] = {date: r.date, setup: r.setup, chip: r.chip};
    else {
      if (JSON.stringify(prev.setup) !== JSON.stringify(r.setup) || prev.chip !== r.chip) {
        errors.push(`${b.fig.id}: run ${r.id} is shared and its setup or chip differs from another figure of the run`);
      }
      if (prev.date && r.date && r.date < prev.date) prev.date = r.date;
    }
  }
  const featured = new Map();
  for (const b of built) {
    if (b.meta.featured) {
      const k = `${b.meta.product}/${b.meta.tier ?? ''}`;
      featured.set(k, (featured.get(k) || 0) + 1);
    }
  }
  for (const [k, n] of featured) if (n > 1) errors.push(`${k}: ${n} featured figures`);

  const products = Object.entries(cfg.products)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([handle, p]) => ({
      handle,
      name: p.name,
      ...(p.coverage ? {coverage: p.coverage} : {}),
      figures: built
        .filter((b) => b.meta.product === handle)
        .sort((a, b) => a.meta.order - b.meta.order || a.fig.id.localeCompare(b.fig.id))
        .map((b) => b.fig.id),
    }))
    .filter((p) => p.figures.length);

  const figures = {};
  for (const b of built) {
    figures[b.fig.id] = {
      title: b.fig.title,
      finding: b.fig.finding,
      product: b.meta.product,
      tier: b.meta.tier,
      featured: b.meta.featured,
      order: b.meta.order,
      domain: b.fig.domain,
      runId: b.fig.runId,
      chip: b.fig.chip,
      caveats: b.fig.caveats.length,
      flagged: b.fig.caveats.filter((c) => c.flag).length,
    };
  }
  const log = [...logItems]
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'status')));
  return {index: {products, runs, figures, log, built: builtAt}, errors};
}

/** Two-space JSON with arrays of plain values on one line, so a series is a few lines. */
export function pretty(o) {
  return (
    JSON.stringify(o, null, 2).replace(/\[\s*([^[\]{}]*?)\s*\]/g, (m, inner) => '[' + inner.replace(/\s*\n\s*/g, ' ') + ']') + '\n'
  );
}
