import type {AxisDef, Fig, FigSeries} from './types.ts';

export type Domain = [number, number];

/** A 1-2-5 step near `range / target`. */
export function niceStep(range: number, target: number): number {
  if (!(range > 0)) return 1;
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nice * mag;
}

export function niceTicks(lo: number, hi: number, target = 6): number[] {
  if (!(hi > lo)) return [lo];
  const step = niceStep(hi - lo, target);
  const start = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

export function tickStep(ticks: number[]): number {
  return ticks.length > 1 ? ticks[1]! - ticks[0]! : 1;
}

/** Tick label: no trailing zeros, `k` for round thousands from 10 000 up. */
export function fmtTick(v: number, step = 1): string {
  if (Math.abs(v) >= 10000 && step >= 1000) return `${Number((v / 1000).toPrecision(6))}k`;
  const dec = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
  return v.toFixed(dec);
}

/** Readout value: 4 significant digits, no exponent. */
export function fmtValue(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return String(Math.round(v));
  if (a >= 100) return v.toFixed(1).replace(/\.0$/, '');
  if (a >= 10) return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function extent(values: Array<number | null | undefined>): Domain | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

function niceRange(d: Domain, target: number, pad: number): Domain {
  let [lo, hi] = d;
  if (hi === lo) {
    lo -= 1;
    hi += 1;
  }
  const span = hi - lo;
  lo -= span * pad;
  hi += span * pad;
  const step = niceStep(hi - lo, target);
  return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

export type Domains = {
  x: Domain;
  y: Domain;
  y2?: Domain;
  /** Dual-axis figures: both y axes have this many intervals, so the gridlines serve both. */
  n?: number;
};

/** `n + 1` evenly spaced ticks from lo to hi. */
export function evenTicks(lo: number, hi: number, n: number): number[] {
  return Array.from({length: n + 1}, (_, i) => Number((lo + ((hi - lo) * i) / n).toPrecision(12)));
}

const STEP_MANTISSAS = [1, 2, 2.5, 4, 5];

/** The smallest nice step and its lower edge that fit extent `e` into n intervals. */
function fitIntervals(e: Domain, n: number, fixedMin?: number): {lo: number; hi: number; waste: number} | null {
  const span = e[1] - e[0] || 1;
  const k0 = Math.floor(Math.log10(span / n)) - 1;
  // A reading may sit up to 3 percent of the span under the lower edge, so an
  // offset of a clamp at zero current does not cost a whole tick of empty axis.
  const tol = fixedMin === undefined ? span * 0.03 : 0;
  for (let k = k0; k <= k0 + 3; k++) {
    for (const m of STEP_MANTISSAS) {
      const step = m * 10 ** k;
      const lo = fixedMin ?? Math.floor((e[0] + tol) / step + 1e-9) * step;
      const hi = lo + n * step;
      if (hi >= e[1] + span * 0.02) return {lo, hi, waste: (hi - lo) / span};
    }
  }
  return null;
}

/** One interval count for both axes, chosen so the two together waste the least. */
function alignDual(e1: Domain, e2: Domain, min1?: number, min2?: number): {y: Domain; y2: Domain; n: number} | null {
  let best: {y: Domain; y2: Domain; n: number; cost: number} | null = null;
  for (const n of [5, 4, 6]) {
    const a = fitIntervals(e1, n, min1);
    const b = fitIntervals(e2, n, min2);
    if (!a || !b) continue;
    const cost = a.waste + b.waste;
    if (!best || cost < best.cost - 1e-9) best = {y: [a.lo, a.hi], y2: [b.lo, b.hi], n, cost};
  }
  return best;
}

function seriesY(s: FigSeries, win?: Domain): Array<number | null | undefined> {
  const out: Array<number | null | undefined> = [];
  for (let i = 0; i < s.x.length; i++) {
    const x = s.x[i];
    if (win && (x === null || x === undefined || x < win[0] || x > win[1])) continue;
    out.push(s.y[i]);
    if (s.lo) out.push(s.lo[i]);
    if (s.hi) out.push(s.hi[i]);
  }
  return out;
}

/**
 * Axis ranges shared by the canvas chart and the static SVG. Fixed `min` and
 * `max` on an axis win; otherwise the range is the nice-rounded extent of the
 * visible series. With an x window the y ranges follow the visible points.
 */
export function figureDomains(
  fig: Fig,
  opts: {hidden?: ReadonlySet<string>; xWindow?: Domain} = {},
): Domains {
  const live = fig.series.filter((s) => !opts.hidden?.has(s.id));
  const use = live.length ? live : fig.series;
  const xs = extent(use.flatMap((s) => s.x));
  const base: Domain = xs ?? [0, 1];
  const ax = fig.axes.x;
  // x is the padded extent, not rounded up to a tick: a 29 762 rpm run should
  // not get an axis to 35 000. Ticks still land on round numbers inside it.
  const xPad = (base[1] - base[0] || 1) * 0.03;
  const xFull: Domain = [ax.min ?? base[0] - xPad, ax.max ?? base[1] + xPad];
  const win = opts.xWindow;
  const extentOf = (axis: 'y' | 'y2'): Domain | null => {
    const group = use.filter((s) => (s.axis === 'y2') === (axis === 'y2'));
    if (!group.length) return null;
    return extent(group.flatMap((s) => seriesY(s, win))) ?? extent(group.flatMap((s) => seriesY(s)));
  };
  const e1 = extentOf('y');
  const e2 = fig.axes.y2 ? extentOf('y2') : null;
  const free = (d: AxisDef | undefined) => d?.max === undefined;
  if (e1 && e2 && free(fig.axes.y) && free(fig.axes.y2)) {
    const a = alignDual(e1, e2, fig.axes.y.min, fig.axes.y2?.min);
    if (a) return {x: win ?? xFull, y: a.y, y2: a.y2, n: a.n};
  }
  const yFor = (axis: 'y' | 'y2'): Domain | undefined => {
    const group = use.filter((s) => (s.axis === 'y2') === (axis === 'y2'));
    if (!group.length) return undefined;
    const def = fig.axes[axis];
    const e = extent(group.flatMap((s) => seriesY(s, win))) ?? extent(group.flatMap((s) => seriesY(s)));
    if (!e) return [0, 1];
    const n = niceRange(e, 5, 0.06);
    return [def?.min ?? n[0], def?.max ?? n[1]];
  };
  return {
    x: win ?? xFull,
    y: yFor('y') ?? [0, 1],
    y2: fig.axes.y2 ? yFor('y2') : undefined,
  };
}

/** Full x range, for the Reset button and the URL state. */
export function fullXDomain(fig: Fig): Domain {
  return figureDomains(fig).x;
}

export type Aligned = {
  x: number[];
  /** `null` = a missing reading (break the line), `undefined` = this series has no sample here (skip). */
  ys: Array<Array<number | null | undefined>>;
  lo: Array<Array<number | null | undefined>>;
  hi: Array<Array<number | null | undefined>>;
};

/** Put every series on one sorted x array, as uPlot wants. Equal x keeps the last reading. */
export function alignSeries(series: FigSeries[]): Aligned {
  const set = new Set<number>();
  for (const s of series) {
    for (const v of s.x) if (v !== null && Number.isFinite(v)) set.add(v);
  }
  const x = [...set].sort((a, b) => a - b);
  const index = new Map(x.map((v, i) => [v, i]));
  const make = () => series.map(() => new Array<number | null | undefined>(x.length).fill(undefined));
  const ys = make();
  const lo = make();
  const hi = make();
  series.forEach((s, k) => {
    for (let i = 0; i < s.x.length; i++) {
      const xv = s.x[i];
      if (xv === null || xv === undefined) continue;
      const at = index.get(xv);
      if (at === undefined) continue;
      ys[k]![at] = s.y[i] ?? null;
      if (s.lo) lo[k]![at] = s.lo[i] ?? null;
      if (s.hi) hi[k]![at] = s.hi[i] ?? null;
    }
  });
  return {x, ys, lo, hi};
}

/** Index of the sample of `s` nearest to x, among samples with a reading. */
export function nearestSample(s: FigSeries, x: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < s.x.length; i++) {
    const xv = s.x[i];
    if (xv === null || xv === undefined || s.y[i] === null || s.y[i] === undefined) continue;
    const d = Math.abs(xv - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Same as nearestSample, by binary search when the series is sorted by x. */
export function nearestSorted(s: FigSeries, x: number): number {
  const xs = s.x;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const v = xs[mid];
    if (v === null || v === undefined) return nearestSample(s, x);
    if (v < x) lo = mid + 1;
    else hi = mid;
  }
  // Check the neighbours for a reading and for the nearest x.
  let best = -1;
  let bestD = Infinity;
  for (let i = Math.max(0, lo - 3); i <= Math.min(xs.length - 1, lo + 3); i++) {
    const xv = xs[i];
    if (xv === null || xv === undefined || s.y[i] === null || s.y[i] === undefined) continue;
    const d = Math.abs(xv - x);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? best : nearestSample(s, x);
}

export function isSortedByX(s: FigSeries): boolean {
  let prev = -Infinity;
  for (const v of s.x) {
    if (v === null || v === undefined) return false;
    if (v < prev) return false;
    prev = v;
  }
  return true;
}
