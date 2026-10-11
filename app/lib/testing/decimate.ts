import type {FigSeries, Fig} from './types.ts';

/** Round to 4 significant digits: enough for a picture, small on the wire. */
export function round4(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Number(v.toPrecision(4));
}

/**
 * Min/max bucketing: every bucket keeps its lowest and highest reading, in
 * original order, so a spike survives the thinning. A bucket with a missing
 * reading keeps one gap, so the line still breaks there. Hold series and any
 * series already at or under the limit are returned unchanged.
 */
export function decimateSeries(s: FigSeries, maxPoints: number, round = false): FigSeries {
  const n = s.x.length;
  if (s.kind === 'hold' || n <= maxPoints) return round ? roundSeries(s) : s;
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const size = n / buckets;
  const x: Array<number | null> = [];
  const y: Array<number | null> = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * size);
    const to = Math.min(n, Math.floor((b + 1) * size));
    let lo = -1;
    let hi = -1;
    let gap = -1;
    for (let i = from; i < to; i++) {
      const v = s.y[i];
      if (v === null || v === undefined || s.x[i] === null) {
        if (gap < 0) gap = i;
        continue;
      }
      if (lo < 0 || v < s.y[lo]!) lo = i;
      if (hi < 0 || v > s.y[hi]!) hi = i;
    }
    const keep = new Set<number>();
    if (lo >= 0) keep.add(lo);
    if (hi >= 0) keep.add(hi);
    if (gap >= 0) keep.add(gap);
    for (const i of [...keep].sort((a, c) => a - c)) {
      x.push(s.x[i] ?? null);
      y.push(s.y[i] ?? null);
    }
  }
  const out = {...s, x, y};
  return round ? roundSeries(out) : out;
}

function roundSeries(s: FigSeries): FigSeries {
  const r = (a?: Array<number | null>) => a?.map(round4);
  const out: FigSeries = {...s, x: s.x.map(round4), y: s.y.map(round4)};
  if (s.lo) out.lo = r(s.lo);
  if (s.hi) out.hi = r(s.hi);
  return out;
}

/** A figure thinned for the first paint (static SVG) and the product card. */
export function previewFigure(fig: Fig, maxPoints: number): Fig {
  return {
    ...fig,
    series: fig.series.map((s) => decimateSeries(s, maxPoints, true)),
  };
}
