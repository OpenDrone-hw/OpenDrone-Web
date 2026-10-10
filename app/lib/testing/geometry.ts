import {assignStyles, type SeriesStyle, type Theme} from './palette.ts';
import {evenTicks, figureDomains, fmtTick, niceTicks, tickStep, type Domain} from './scale.ts';
import type {Fig, FigSeries} from './types.ts';

/**
 * Plot geometry for the static SVG: the server-rendered first paint of every
 * figure, the product-page card and the SVG download. It uses the same domains
 * and styles as the canvas chart, so the two cannot disagree about a range.
 */

export type GeomOptions = {
  w: number;
  h: number;
  theme?: Theme;
  /** Product-page card: 3 to 4 ticks per axis, shorter margins, no second axis title room. */
  compact?: boolean;
  hidden?: ReadonlySet<string>;
  xWindow?: Domain;
};

export type GeomSeries = {
  id: string;
  label: string;
  kind: FigSeries['kind'];
  style: SeriesStyle;
  /** Path data; absent for hold series, which are never joined by a line. */
  d?: string;
  /** Marker centres: hold medians, and every point of a short series. */
  dots: Array<[number, number]>;
  /** Hold interquartile bars, [x, yLo, yHi]. */
  bars: Array<[number, number, number]>;
};

export type Tick = {p: number; label: string};

export type Geometry = {
  w: number;
  h: number;
  plot: {x0: number; y0: number; x1: number; y1: number};
  xTicks: Tick[];
  yTicks: Tick[];
  y2Ticks: Tick[];
  series: GeomSeries[];
  /** The fitted law as path data, when the figure has one. */
  fit?: string;
  /** Value label at the last point of the first series that has points. */
  end?: {x: number; y: number; text: string};
};

export const TICK_PX = 11;
/** Left gutter, shared by every figure so plots of one row line up. */
export const GUTTER_L = 52;

const r1 = (v: number) => Math.round(v * 10) / 10;

export function buildGeometry(fig: Fig, opt: GeomOptions): Geometry {
  const {w, h, compact} = opt;
  const theme: Theme = opt.theme ?? 'light';
  const dom = figureDomains(fig, {hidden: opt.hidden, xWindow: opt.xWindow});
  const hasY2 = Boolean(dom.y2);
  const m = compact
    ? {l: GUTTER_L, r: hasY2 ? GUTTER_L : 16, t: 12, b: 40}
    : {l: GUTTER_L, r: hasY2 ? GUTTER_L : 14, t: 10, b: 38};
  const plot = {x0: m.l, y0: m.t, x1: w - m.r, y1: h - m.b};
  const sx = (v: number) => plot.x0 + ((v - dom.x[0]) / (dom.x[1] - dom.x[0] || 1)) * (plot.x1 - plot.x0);
  const sy = (v: number, d: Domain) => plot.y1 - ((v - d[0]) / (d[1] - d[0] || 1)) * (plot.y1 - plot.y0);
  const styles = assignStyles(fig.series, theme);

  const mkTicks = (d: Domain, count: number, scale: (v: number) => number, even?: number): Tick[] => {
    const t = even ? evenTicks(d[0], d[1], even) : niceTicks(d[0], d[1], count);
    const step = tickStep(t);
    return t.map((v) => ({p: scale(v), label: fmtTick(v, step)}));
  };
  const yCount = Math.min(compact ? 4 : 5, Math.max(3, Math.floor((plot.y1 - plot.y0) / 56)));
  const xTicks = mkTicks(dom.x, compact ? 4 : Math.max(3, Math.min(8, Math.floor((plot.x1 - plot.x0) / 100))), sx);
  const yTicks = mkTicks(dom.y, yCount, (v) => sy(v, dom.y), dom.n);
  const y2Ticks = dom.y2 ? mkTicks(dom.y2, yCount, (v) => sy(v, dom.y2!), dom.n) : [];

  const series: GeomSeries[] = [];
  let end: Geometry['end'];
  for (const s of fig.series) {
    if (opt.hidden?.has(s.id)) continue;
    // Logged frames are drawn by the interactive chart only.
    if (s.kind === 'frames') continue;
    const d = s.axis === 'y2' && dom.y2 ? dom.y2 : dom.y;
    const dots: Array<[number, number]> = [];
    const bars: Array<[number, number, number]> = [];
    let path = '';
    let pen = false;
    for (let i = 0; i < s.x.length; i++) {
      const xv = s.x[i];
      const yv = s.y[i];
      if (xv === null || xv === undefined || yv === null || yv === undefined) {
        pen = false;
        continue;
      }
      if (opt.xWindow && (xv < opt.xWindow[0] || xv > opt.xWindow[1])) {
        pen = false;
        continue;
      }
      const px = r1(sx(xv));
      const py = r1(sy(yv, d));
      if (s.kind !== 'hold') {
        path += `${pen ? 'L' : 'M'}${px} ${py}`;
        pen = true;
      }
      if (s.kind === 'hold' || s.x.length <= 24) dots.push([px, py]);
      const lo = s.lo?.[i];
      const hi = s.hi?.[i];
      if (s.kind === 'hold' && lo !== null && lo !== undefined && hi !== null && hi !== undefined) {
        bars.push([px, r1(sy(lo, d)), r1(sy(hi, d))]);
      }
    }
    if (!end && s.x.length) {
      const i = s.y.length - 1 - [...s.y].reverse().findIndex((v) => v !== null && v !== undefined);
      const xv = s.x[i];
      const yv = s.y[i];
      if (xv !== null && xv !== undefined && yv !== null && yv !== undefined && i >= 0) {
        const ax = s.axis === 'y2' ? fig.axes.y2 : fig.axes.y;
        end = {x: r1(sx(xv)), y: r1(sy(yv, d)), text: `${fmtEnd(yv)} ${ax?.unit ?? ''}`.trim()};
      }
    }
    series.push({
      id: s.id,
      label: s.label,
      kind: s.kind,
      style: styles[s.id]!,
      d: s.kind === 'hold' ? undefined : path || undefined,
      dots,
      bars,
    });
  }
  let fit: string | undefined;
  if (fig.fit && !opt.xWindow) {
    const {k, x0, x1} = fig.fit;
    let d = '';
    for (let i = 0; i <= 32; i++) {
      const xv = x0 + ((x1 - x0) * i) / 32;
      d += `${i ? 'L' : 'M'}${r1(sx(xv))} ${r1(sy(k * (xv / 1000) ** 2, dom.y))}`;
    }
    fit = d;
  }
  return {w, h, plot, xTicks, yTicks, y2Ticks, series, fit, end};
}

/** Four significant digits, no exponent, for the label at the end of a line. */
function fmtEnd(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? String(Math.round(v)) : a >= 100 ? String(Math.round(v * 10) / 10) : String(Math.round(v * 100) / 100);
}

/** Path data for a marker of the given shape, centred on (x, y), radius r. */
export function markerPath(shape: SeriesStyle['marker'], x: number, y: number, r: number): string {
  if (shape === 'square') return `M${x - r} ${y - r}h${2 * r}v${2 * r}h${-2 * r}z`;
  if (shape === 'diamond') return `M${x} ${y - r * 1.3}L${x + r * 1.3} ${y}L${x} ${y + r * 1.3}L${x - r * 1.3} ${y}z`;
  return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
}
