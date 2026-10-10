import {assignStyles, type SeriesStyle, type Theme} from './palette.ts';
import {evenTicks, figureDomains, fmtTickSet, niceTicks, unitLabel, type Domain} from './scale.ts';
import {directLabelled, directPad, plainLabel} from './labels.ts';
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
  /** The y axis titles are drawn in the SVG, above the plot. False when the page writes them in HTML. */
  titles?: boolean;
  /** The y axis title is turned and hung in the left gutter, beside the tick labels, as in the exports. */
  side?: boolean;
  /** Narrow plot: no end labels, the legend names the runs. */
  narrow?: boolean;
  hidden?: ReadonlySet<string>;
  xWindow?: Domain;
};

export type GeomSeries = {
  id: string;
  label: string;
  kind: FigSeries['kind'];
  style: SeriesStyle;
  /** Path data. A hold series has one only when `connectsHolds` says its markers are joined. */
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
  /** Text written on the plot: end value, fit, marks. Positions are clear of markers and of each other. */
  notes: Note[];
  /** Vertical mark lines: a thin dashed line from the axis to the top of the plot with its number in a small circle. */
  lines: Array<{x: number; row: number; text: string}>;
  /** Rings on marked points: x, y and the id of the series. */
  rings: Array<[number, number, string]>;
  /** The first series on each y axis, for coloured axis titles. */
  axisSeries: {y?: string; y2?: string};
};

export type Note = {
  lines: string[];
  left: number;
  top: number;
  w: number;
  h: number;
  sid?: string;
  /** A leader from the ring of a marked point to its label: x1, y1, x2, y2. */
  leader?: [number, number, number, number];
};

export const TICK_PX = 12;
/** Left gutter, shared by every figure so plots line up. The axis title sits above the plot, not rotated beside it. */
export const GUTTER_L = 54;
/** Left gutter on a phone. */
export const GUTTER_L_NARROW = 42;
/** Left gutter that holds tick labels and the turned axis title; on a wide page it hangs in the page margin. */
export const GUTTER_SIDE = 64;
/** Marker radius of a point on a line, 5 px across. */
export const DOT_R = 2.5;
/** A series with this many points or more is drawn as a line with one marker at its end. */
export const MARKS_BELOW = 10;
/** Height of one row of the strip above the plot that carries mark-line labels. */
export const MARK_ROW = 15;
/** Average width of one character of a 12 px label, for the SVG, which cannot measure text. */
export const CHAR_PX = 7.2;
/** Hold markers are always joined by a thin line; a fitted law is a separate dashed line over them. */
export const connectsHolds = (_fig: Fig) => true;
/** Hold marker radius in css px: 7 px across. */
export const MARKER_R = 3.5;

const r1 = (v: number) => Math.round(v * 10) / 10;

export function buildGeometry(fig: Fig, opt: GeomOptions): Geometry {
  const {w, h, compact} = opt;
  const theme: Theme = opt.theme ?? 'light';
  const dom = figureDomains(fig, {hidden: opt.hidden, xWindow: opt.xWindow});
  const hasY2 = Boolean(dom.y2);
  const top = opt.titles === false || opt.side ? 12 : 26;
  const gl = opt.side ? GUTTER_SIDE : opt.narrow ? GUTTER_L_NARROW : GUTTER_L;
  const m = {l: gl, r: (hasY2 ? gl : 16) + directPad(fig, Boolean(opt.narrow)), t: top, b: 38};
  const plot = {x0: m.l, y0: m.t, x1: w - m.r, y1: h - m.b};
  const sx = (v: number) => plot.x0 + ((v - dom.x[0]) / (dom.x[1] - dom.x[0] || 1)) * (plot.x1 - plot.x0);
  const sy = (v: number, d: Domain) => plot.y1 - ((v - d[0]) / (d[1] - d[0] || 1)) * (plot.y1 - plot.y0);
  const styles = assignStyles(fig.series, theme);

  const mkTicks = (d: Domain, count: number, scale: (v: number) => number, even?: number): Tick[] => {
    const t = even ? evenTicks(d[0], d[1], even) : niceTicks(d[0], d[1], count);
    const labels = fmtTickSet(t);
    return t.map((v, i) => ({p: scale(v), label: labels[i]!}));
  };
  const yCount = Math.min(compact ? 4 : 5, Math.max(3, Math.floor((plot.y1 - plot.y0) / 56)));
  const xTicks = mkTicks(dom.x, compact ? 4 : Math.max(3, Math.min(8, Math.floor((plot.x1 - plot.x0) / 100))), sx);
  const yTicks = mkTicks(dom.y, yCount, (v) => sy(v, dom.y), hasY2 ? dom.n : undefined);
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
    let count = 0;
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
      if (s.kind !== 'hold' || connectsHolds(fig)) {
        path += `${pen ? 'L' : 'M'}${px} ${py}`;
        pen = true;
      }
      if (s.kind === 'hold' || s.x.length <= 24) dots.push([px, py]);
      if (s.kind === 'hold' || s.x.length <= 24) count += 1;
      const lo = s.lo?.[i];
      const hi = s.hi?.[i];
      if (s.kind === 'hold' && lo !== null && lo !== undefined && hi !== null && hi !== undefined) {
        bars.push([px, r1(sy(lo, d)), r1(sy(hi, d))]);
      }
    }
    // Ten points or more: a line with one marker at its end, not a marker on every point.
    if (count >= MARKS_BELOW) dots.splice(0, dots.length - 1);
    if (!end && s.x.length) {
      const i = s.y.length - 1 - [...s.y].reverse().findIndex((v) => v !== null && v !== undefined);
      const xv = s.x[i];
      const yv = s.y[i];
      if (xv !== null && xv !== undefined && yv !== null && yv !== undefined && i >= 0) {
        const ax = s.axis === 'y2' ? fig.axes.y2 : fig.axes.y;
        end = {x: r1(sx(xv)), y: r1(sy(yv, d)), text: `${fmtEnd(yv)} ${unitLabel(ax?.unit ?? '')}`.trim()};
      }
    }
    series.push({
      id: s.id,
      label: s.label,
      kind: s.kind,
      style: styles[s.id]!,
      d: path || undefined,
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
  const axisSeries: Geometry['axisSeries'] = {};
  for (const s of fig.series) {
    const k = s.axis === 'y2' ? 'y2' : 'y';
    axisSeries[k] ??= s.id;
  }
  const measure = (t: string) => t.length * CHAR_PX;
  const laid = layoutNotes(fig, {
    px: sx,
    py: (v, axis) => sy(v, axis === 'y2' && dom.y2 ? dom.y2 : dom.y),
    plot,
    measure,
    styles,
    hidden: opt.hidden,
    narrow: opt.narrow,
    xWindow: opt.xWindow,
    rightPad: directPad(fig, Boolean(opt.narrow)),
  });
  return {w, h, plot, xTicks, yTicks, y2Ticks, series, fit, end, notes: laid.notes, lines: laid.lines, rings: laid.rings, axisSeries};
}

/** Four significant digits, no exponent, for the label at the end of a line. */
function fmtEnd(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 ? String(Math.round(v)) : a >= 100 ? String(Math.round(v * 10) / 10) : String(Math.round(v * 100) / 100);
}

/** Path data for a marker of the given shape, centred on (x, y), radius r. */
export function markerPath(shape: SeriesStyle['marker'], x: number, y: number, r: number): string {
  if (shape === 'square') return `M${x - r} ${y - r}h${2 * r}v${2 * r}h${-2 * r}z`;
  if (shape === 'triangle') return `M${x} ${y - r * 1.25}L${x + r * 1.2} ${y + r * 0.9}L${x - r * 1.2} ${y + r * 0.9}z`;
  if (shape === 'diamond') return `M${x} ${y - r * 1.3}L${x + r * 1.3} ${y}L${x} ${y + r * 1.3}L${x - r * 1.3} ${y}z`;
  return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
}

export type LabelBox = {x: number; y: number; w: number; h: number; dir?: 'ul' | 'lr' | 'r' | 'u' | 'far'};
export type Rect = {left: number; top: number; w: number; h: number};

const hit = (a: Rect, b: Rect, pad = 0) =>
  a.left < b.left + b.w + pad && a.left + a.w + pad > b.left && a.top < b.top + b.h + pad && a.top + a.h + pad > b.top;

/**
 * Where to write each label so that none sits on a marker, on a line, on
 * another label or outside the plot. Each label tries its preferred side
 * first, then the usual offsets around its point, and takes the first that is
 * clear; if none is clear it takes the one that covers the fewest things.
 * `markers` are every marker centre of the figure, `thin` are sample points of
 * lines (a joined hold series, the fit). Units are the caller's (css px).
 */
export function placeLabels(
  labels: LabelBox[],
  markers: Array<[number, number]>,
  bounds: {x0: number; y0: number; x1: number; y1: number},
  markerR = 4,
  thin: Array<[number, number]> = [],
): Rect[] {
  const placed: Rect[] = [];
  const dots: Rect[] = [
    ...markers.map(([x, y]) => ({left: x - markerR - 1, top: y - markerR - 1, w: 2 * markerR + 2, h: 2 * markerR + 2})),
    ...thin.map(([x, y]) => ({left: x - 1.5, top: y - 1.5, w: 3, h: 3})),
  ];
  for (const l of labels) {
    const {x, y, w, h} = l;
    const g = markerR + 5;
    const around: Rect[] = [
      {left: x + g, top: y - h / 2, w, h},
      {left: x - g - w, top: y - h - 3, w, h},
      {left: x - w / 2, top: y - h - g, w, h},
      {left: x - g - w, top: y - h / 2, w, h},
      {left: x - g - w, top: y + 3, w, h},
      {left: x - w / 2, top: y + g, w, h},
      {left: x + g, top: y - h - 3, w, h},
      {left: x + g, top: y + 3, w, h},
      {left: bounds.x1 - w, top: y + g, w, h},
      {left: bounds.x1 - w, top: y - h - g, w, h},
    ];
    const first: Rect | null =
      l.dir === 'r'
        ? {left: x + g, top: y - h / 2, w, h}
        : l.dir === 'far'
        ? {left: x + g + 12, top: y + g + 14, w, h}
        : l.dir === 'ul'
        ? {left: x - g - w + 2, top: y - h - g + 2, w, h}
        : l.dir === 'lr'
          ? {left: x + g - 2, top: y + g - 2, w, h}
          : l.dir === 'u'
            ? {left: x - w / 2, top: y - h - g, w, h}
            : null;
    const cands = first ? [first, ...around] : around;
    const cost = (r: Rect) => {
      let c = 0;
      if (r.left < bounds.x0 || r.left + r.w > bounds.x1 || r.top < bounds.y0 || r.top + r.h > bounds.y1) c += 100;
      for (const d of dots) if (hit(r, d)) c += 10;
      for (const p of placed) if (hit(r, p, 2)) c += 10;
      return c;
    };
    let best = cands[0]!;
    let bestCost = Infinity;
    for (const c of cands) {
      const k = cost(c);
      if (k < bestCost) {
        best = c;
        bestCost = k;
        if (k === 0) break;
      }
    }
    placed.push(best);
  }
  return placed;
}

/** What the notes need to know about a plot. All positions are css px in one frame. */
export type Frame = {
  px: (x: number) => number;
  py: (y: number, axis: 'y' | 'y2') => number;
  plot: {x0: number; y0: number; x1: number; y1: number};
  measure: (text: string) => number;
  styles: Record<string, SeriesStyle>;
  hidden?: ReadonlySet<string>;
  narrow?: boolean;
  /** The visible x window, when zoomed: marks outside it are not drawn. */
  xWindow?: Domain;
  /** Room right of the plot that labels may use. */
  rightPad?: number;
};

/**
 * Vertical mark lines of a figure, left to right. With two or more they are numbered on the plot and their
 * text is written under the figure, so no two labels crowd each other.
 */
export function markLines(fig: Fig): Array<{no: number; text: string}> {
  const ml = (fig.marks ?? []).filter((m) => m.kind === 'line').sort((a, b) => a.x - b.x);
  return ml.map((m, i) => ({no: i + 1, text: m.text}));
}

/** The fit as a short legend entry: `1.71 g/krpm²`. */
export const fitShort = (k: number, unit: string) => `${k} ${unit.replace(/ per /, '/').replace(/ squared$/, '²')}`;

function wrap(text: string, maxW: number, measure: (t: string) => number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const t = cur ? `${cur} ${word}` : word;
    if (measure(t) > maxW && cur) {
      out.push(cur);
      cur = word;
    } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The words written on a plot, placed once for both renderers: the last value
 * of the hold series that reaches furthest, the fitted law's value, the point
 * marks, and the labels of the vertical mark lines in a strip above the plot.
 * The other series are named by the legend or a direct label, not here.
 */
export function layoutNotes(
  fig: Fig,
  f: Frame,
): {notes: Note[]; lines: Geometry['lines']; rings: Geometry['rings']; centres: Array<[number, number]>} {
  const {plot} = f;
  const hidden = f.hidden;
  const lh = TICK_PX + 3;
  const shown = fig.series.filter((s) => !hidden?.has(s.id) && s.kind !== 'frames');
  const unitOf = (s: FigSeries) => unitLabel((s.axis === 'y2' ? fig.axes.y2 : fig.axes.y)?.unit ?? '');
  const centres: Array<[number, number]> = [];
  const thin: Array<[number, number]> = [];
  const lastOf = (s: FigSeries) => {
    for (let i = s.x.length - 1; i >= 0; i--) if (s.x[i] != null && s.y[i] != null) return i;
    return -1;
  };
  for (const s of shown) {
    if (s.kind !== 'hold') continue;
    const axis = s.axis === 'y2' ? 'y2' : 'y';
    let prev: [number, number] | null = null;
    for (let i = 0; i < s.x.length; i++) {
      if (s.x[i] == null || s.y[i] == null) continue;
      const p: [number, number] = [f.px(s.x[i]!), f.py(s.y[i]!, axis)];
      centres.push(p);
      if (prev && connectsHolds(fig)) {
        for (let k = 1; k < 6; k++) thin.push([prev[0] + ((p[0] - prev[0]) * k) / 6, prev[1] + ((p[1] - prev[1]) * k) / 6]);
      }
      prev = p;
    }
  }
  if (fig.fit) {
    const {k, x0, x1} = fig.fit;
    for (let i = 0; i <= 40; i++) {
      const xv = x0 + ((x1 - x0) * i) / 40;
      thin.push([f.px(xv), f.py(k * (xv / 1000) ** 2, 'y')]);
    }
  }

  type Item = {text: string[]; x: number; y: number; sid?: string; dir: LabelBox['dir']; ring?: boolean};
  const items: Item[] = [];
  const inWin = (x: number) => !f.xWindow || (x >= f.xWindow[0] && x <= f.xWindow[1]);

  // Point marks first: they are the most specific.
  const rings: Geometry['rings'] = [];
  for (const m of fig.marks ?? []) {
    if (m.kind !== 'point' || m.y === undefined || !inWin(m.x)) continue;
    const s = fig.series.find((q) => q.id === m.series);
    if (!s || hidden?.has(s.id)) continue;
    const axis = s.axis === 'y2' ? 'y2' : 'y';
    const x = f.px(m.x);
    const y = f.py(m.y, axis);
    rings.push([x, y, s.id]);
    items.push({text: wrap(m.text, f.narrow ? 118 : 160, f.measure), x, y, sid: s.id, dir: 'far', ring: true});
  }

  // Direct labels: a name at the right end of each line, in its colour.
  if (directLabelled(fig)) {
    for (const s of shown) {
      if (s.kind !== 'trace') continue;
      const axis = s.axis === 'y2' ? 'y2' : 'y';
      let prevX = -Infinity;
      for (let i = 0; i < s.x.length; i++) {
        if (s.x[i] == null || s.y[i] == null) continue;
        const x = f.px(s.x[i]!);
        if (x - prevX < 5) continue;
        prevX = x;
        thin.push([x, f.py(s.y[i]!, axis)]);
      }
      const i = lastOf(s);
      if (i < 0) continue;
      items.push({
        text: [plainLabel(s.label, s.short)],
        x: f.px(s.x[i]!),
        y: f.py(s.y[i]!, axis),
        sid: s.id,
        dir: 'r',
      });
    }
  }

  const boxes: LabelBox[] = items.map((it) => ({
    x: it.x,
    y: it.y,
    w: Math.max(...it.text.map((t) => f.measure(t))),
    h: it.text.length * lh,
    dir: it.dir,
  }));
  const rects = placeLabels(boxes, centres, {...plot, x1: plot.x1 + (f.rightPad ?? 0) - 2}, MARKER_R, thin);
  const notes: Note[] = items.map((it, n) => {
    const r = rects[n]!;
    const note: Note = {lines: it.text, left: r.left, top: r.top, w: r.w, h: r.h, sid: it.sid};
    if (it.ring) {
      // Leader from the edge of the ring to the nearest point of the label.
      const tx = Math.min(r.left + r.w, Math.max(r.left, it.x));
      const ty = Math.min(r.top + r.h, Math.max(r.top, it.y));
      const d = Math.hypot(tx - it.x, ty - it.y);
      const R = MARKER_R + 4;
      if (d > R + 4) note.leader = [it.x + ((tx - it.x) * R) / d, it.y + ((ty - it.y) * R) / d, tx, ty];
    }
    return note;
  });

  // Marks on the x axis: a short tick and its number, the wording is in the caption.
  const lines: Geometry['lines'] = [];
  const ml = (fig.marks ?? []).filter((m) => m.kind === 'line' && inWin(m.x)).sort((a, b) => a.x - b.x);
  ml.forEach((m, i) => lines.push({x: f.px(m.x), row: 0, text: String(i + 1)}));
  return {notes, lines, rings, centres};
}

/**
 * The corner of the plot with the least data under it, where the legend can stand without covering a line.
 * Null when every corner has something in it: the legend then stays in a row under the plot.
 */
export function legendCorner(fig: Fig, hidden?: ReadonlySet<string>): 'tl' | 'tr' | 'bl' | 'br' | null {
  const dom = figureDomains(fig, {hidden});
  const hits: Record<'tl' | 'tr' | 'bl' | 'br', number> = {tl: 0, tr: 0, bl: 0, br: 0};
  const note = (x: number, y: number, d: Domain) => {
    const fx = (x - dom.x[0]) / (dom.x[1] - dom.x[0] || 1);
    const fy = (y - d[0]) / (d[1] - d[0] || 1);
    const side = fx < 0.3 ? 'l' : fx > 0.7 ? 'r' : null;
    if (!side) return;
    if (fy > 0.68) hits[side === 'l' ? 'tl' : 'tr'] += 1;
    if (fy < 0.3) hits[side === 'l' ? 'bl' : 'br'] += 1;
  };
  for (const s of fig.series) {
    if (hidden?.has(s.id) || s.kind === 'frames') continue;
    const d = s.axis === 'y2' && dom.y2 ? dom.y2 : dom.y;
    let prev: [number, number] | null = null;
    for (let i = 0; i < s.x.length; i++) {
      const x = s.x[i];
      const y = s.y[i];
      if (x === null || x === undefined || y === null || y === undefined) {
        prev = null;
        continue;
      }
      if (prev) for (let k = 1; k <= 8; k++) note(prev[0] + ((x - prev[0]) * k) / 8, prev[1] + ((y - prev[1]) * k) / 8, d);
      else note(x, y, d);
      prev = [x, y];
    }
  }
  if (fig.fit) {
    const {k, x0, x1} = fig.fit;
    for (let i = 0; i <= 40; i++) {
      const xv = x0 + ((x1 - x0) * i) / 40;
      note(xv, k * (xv / 1000) ** 2, dom.y);
    }
  }
  const order: Array<'tl' | 'tr' | 'br' | 'bl'> = ['tl', 'tr', 'br', 'bl'];
  const best = order.reduce((a, b) => (hits[b] < hits[a] ? b : a));
  return hits[best] === 0 ? best : null;
}
