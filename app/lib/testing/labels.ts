import type {Fig} from './types.ts';

/**
 * The name drawn on the plot: the view's `short` name for the series when it
 * has one, else the label without the suffixes the exporter adds for the
 * reduction.
 */
export function plainLabel(label: string, short?: string): string {
  return short ?? label.replace(/, (frames|hold median.*)$/, '').replace(/, \d+ s$/, '');
}

/**
 * Two to four line traces on one axis are named at their right ends, in the
 * colour of the line, in place of a legend.
 */
export function directLabelled(fig: Fig): boolean {
  const traces = fig.series.filter((s) => s.kind === 'trace');
  return (
    traces.length >= 2 &&
    traces.length <= 4 &&
    traces.length === fig.series.length &&
    !fig.series.some((s) => s.axis === 'y2')
  );
}

/** A two-axis figure names each axis in the colour of its line, above the plot. */
export const isDual = (fig: Fig): boolean => fig.series.some((s) => s.axis === 'y2');

/** Room kept right of the plot for end labels, css px. */
export function directPad(fig: Fig, narrow: boolean): number {
  if (!directLabelled(fig) || narrow) return 0;
  const widest = Math.max(...fig.series.map((s) => plainLabel(s.label).length * 7.2));
  return Math.round(Math.min(140, Math.max(64, widest + 18)));
}

type S = Fig['series'][number];
const keyOf = (s: S) => `${s.quantity}/${s.pack ?? s.id}`;

/** Frames of a pack that has something else drawn: they get their own switch. */
export function frameIdsOf(fig: Fig): string[] {
  const framed = new Set(fig.series.filter((s) => s.kind !== 'frames').map(keyOf));
  return fig.series.filter((s) => s.kind === 'frames' && framed.has(keyOf(s))).map((s) => s.id);
}

/** Raw frames start hidden: the hold medians and the fit are the figure, the frames are its evidence. */
export function defaultHidden(fig: Fig): Set<string> {
  return new Set(frameIdsOf(fig));
}
