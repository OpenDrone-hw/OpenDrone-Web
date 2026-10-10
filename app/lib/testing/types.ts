/**
 * Shapes of the files `scripts/sync-testing.mjs` writes to `public/testing/`.
 * `index.json` is small and always loaded; `fig/<id>.json` is one figure and is
 * fetched when the figure nears the viewport.
 */

export type SeriesKind = 'trace' | 'frames' | 'hold';

export type FigSeries = {
  id: string;
  label: string;
  /** One hue per quantity: current, voltage, temperature, rpm, command, aux, thrust. */
  quantity: string;
  /** Pack, motor or unit. Series of one quantity differ by shade and dash. */
  pack?: string;
  kind: SeriesKind;
  axis?: 'y2';
  /** `null` is a missing reading and is never interpolated. */
  x: Array<number | null>;
  y: Array<number | null>;
  /** Hold series only: 25th and 75th percentile of the last 2 s. */
  lo?: Array<number | null>;
  hi?: Array<number | null>;
};

export type AxisDef = {
  label: string;
  unit: string;
  min?: number;
  max?: number;
};

export type Caveat = string | {text: string; flag?: boolean};

export type Fig = {
  id: string;
  title: string;
  finding: string;
  product?: string;
  tier?: string | null;
  runId: string;
  domain: string;
  chip: string;
  caveats: Caveat[];
  reduction?: string;
  cite?: string;
  axes: {x: AxisDef; y: AxisDef; y2?: AxisDef};
  series: FigSeries[];
  /** x of the point the finding is drawn against, when the view sets one. */
  callout_x?: number;
  /** One record per throttle hold of a thrust stand figure. */
  holds?: Array<{run: string; throttle: number; t0: number; t1: number; n: number}>;
  /** Quadratic law through the holds at or above a throttle: y = k (x / 1000)^2. */
  fit?: FigFit;
};

export type FigFit = {
  k: number;
  unit: string;
  fromThrottle: number;
  x0: number;
  x1: number;
  maxMiss: number;
  n: number;
};

export type RunInfo = {date: string; setup: string[]; chip: string};

export type FigSummary = {
  title: string;
  finding: string;
  product: string;
  tier: string | null;
  featured: boolean;
  order: number;
  domain: string;
  runId: string;
  chip: string;
  caveats: number;
  flagged: number;
};

export type LogEntry = {
  id: string;
  date: string;
  product: string;
  tested: string;
  saw: string;
  changed: string | null;
  figureId?: string;
};

export type TestingIndex = {
  products: Array<{
    handle: string;
    name: string;
    /** What the figures cover and what is not measured yet. */
    coverage?: {done: string[]; gaps?: string[]};
    figures: string[];
  }>;
  runs: Record<string, RunInfo>;
  figures: Record<string, FigSummary>;
  log: LogEntry[];
  built: string;
};

export function caveatText(c: Caveat): string {
  return typeof c === 'string' ? c : c.text;
}

export function caveatFlagged(c: Caveat): boolean {
  return typeof c !== 'string' && c.flag === true;
}
