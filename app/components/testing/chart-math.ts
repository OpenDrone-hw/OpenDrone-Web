/**
 * Scales and ticks for TestChart, kept free of React so node:test can run them.
 */

export type Scale = {
  kind: 'linear' | 'log';
  d0: number;
  d1: number;
  r0: number;
  r1: number;
};

export function project(s: Scale, v: number): number {
  if (s.kind === 'log') {
    const a = Math.log10(Math.max(s.d0, 1e-12));
    const b = Math.log10(Math.max(s.d1, 1e-12));
    const t = (Math.log10(Math.max(v, 1e-12)) - a) / (b - a || 1);
    return s.r0 + t * (s.r1 - s.r0);
  }
  const t = (v - s.d0) / (s.d1 - s.d0 || 1);
  return s.r0 + t * (s.r1 - s.r0);
}

/** Round a step up to 1, 2 or 5 times a power of ten. */
function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return n * p;
}

/** Tick values covering [lo, hi]; the first and last are inside the range. */
export function niceTicks(
  lo: number,
  hi: number,
  target: number,
  kind: 'linear' | 'log' = 'linear',
): number[] {
  if (!(hi > lo)) return [lo];
  if (kind === 'log') {
    const out: number[] = [];
    const a = Math.ceil(Math.log10(Math.max(lo, 1e-12)));
    const b = Math.floor(Math.log10(hi));
    for (let e = a; e <= b; e++) out.push(Math.pow(10, e));
    return out.length ? out : [lo, hi];
  }
  const step = niceStep((hi - lo) / Math.max(1, target));
  const first = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = first; v <= hi + step * 1e-9; v += step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

/** Widen [lo, hi] to tick boundaries so the data never touches the frame. */
export function niceDomain(
  lo: number,
  hi: number,
  target: number,
): [number, number] {
  if (!(hi > lo)) {
    const d = Math.abs(lo) || 1;
    return [lo - d * 0.5, hi + d * 0.5];
  }
  const step = niceStep((hi - lo) / Math.max(1, target));
  return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

/** Index of the entry in a sorted array nearest to v. */
export function nearestIndex(sorted: number[], v: number): number {
  if (sorted.length === 0) return -1;
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < v) lo = mid;
    else hi = mid;
  }
  return Math.abs(sorted[lo]! - v) <= Math.abs(sorted[hi]! - v) ? lo : hi;
}

/** Up to four significant digits, no trailing zeros, no exponent for chart ranges. */
export function fmt(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return String(Math.round(v));
  const s = Number(v.toPrecision(4));
  return String(s);
}

const UNIT: Record<string, string> = {
  degC: '°C',
  us: 'µs',
  percent: '%',
};

export function unitLabel(u: string): string {
  return UNIT[u] ?? u;
}
