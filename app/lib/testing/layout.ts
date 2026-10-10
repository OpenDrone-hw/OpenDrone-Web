import {unitLabel} from './scale.ts';
import type {AxisDef, Fig, TestingIndex} from './types.ts';

/**
 * Layout decisions that read the figure files. No figure's wording is written
 * here: it all comes from the publish block of its saved view.
 */

/** A panel whose figure is drawn in full by another figure is not stacked. */
export const isDuplicate = (index: TestingIndex, id: string): boolean => Boolean(index.figures[id]?.duplicateOf);

/** Where a figure's own anchor is, when its panel is not drawn: links go to the figure that shows it. */
export const anchorFor = (index: TestingIndex, id: string): string => index.figures[id]?.duplicateOf ?? id;

export function axisTitle(fig: Fig, axis: 'x' | 'y' | 'y2'): string {
  const a: AxisDef | undefined = fig.axes[axis];
  if (!a) return '';
  return `${a.label} (${unitLabel(a.unit)}${a.note ? `, ${a.note}` : ''})`;
}

/**
 * The figures of the page in document order: products as listed, figures as
 * listed, a figure drawn in full by another one left out. Each gets its number
 * and the number of its section, so a finding reads 2.1 for the first note or
 * measurement under Figure 2. A figure without a preview is not drawn and has none.
 */
export type Numbered = {id: string; no: number; section: number};
export function numberFigures(index: TestingIndex, has: (id: string) => boolean): Numbered[] {
  const out: Numbered[] = [];
  index.products.forEach((p, i) => {
    for (const id of p.figures) {
      if (index.figures[id] && has(id) && !isDuplicate(index, id)) out.push({id, no: out.length + 1, section: i + 1});
    }
  });
  return out;
}

/** Where a link to a figure lands, as text: `Figure 3`, following a duplicate to the figure that draws it. */
export function figureLabel(numbers: Numbered[], index: TestingIndex, id: string): string | null {
  const n = numbers.find((q) => q.id === anchorFor(index, id));
  return n ? `Figure ${n.no}` : null;
}

/** The run photos of the page in document order: the photo of the first run of a section that has one. */
export function photoNumbers(index: TestingIndex): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  for (const p of index.products) {
    const run = [...new Set(p.figures.map((f) => index.figures[f]?.runId))].find((r) => r && index.runs[r]?.photo);
    if (run) out[p.handle] = ++n;
  }
  return out;
}

/**
 * The short source line of a figure: the run id, its date and the capture times of its logs,
 * or the number of logs when they carry no time.
 * The full paths stay in the figure's values fold.
 */
export function sourceLine(runId: string, date: string | undefined, cite: string | undefined): string {
  const id = runId.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const logs = (cite ?? '').split('; ').filter(Boolean);
  const times = logs.map((l) => /\d{8}T(\d{2})(\d{2})\d{2}Z/.exec(l)).map((m) => (m ? `${m[1]}:${m[2]}` : null));
  void date;
  if (times.length && times.every(Boolean)) return `${id}, ${[...new Set(times)].join(', ')} UTC`;
  if (logs.length) return `${id}, ${logs.length} ${logs.length === 1 ? 'log' : 'logs'}`;
  return id;
}

/**
 * The reduction of a run, stated once: every sentence of its figures' reductions in order of first
 * appearance. A sentence that only one figure of a run with several figures has names that figure.
 */
export function runReduction(figs: Array<{no: number; reduction?: string}>): string {
  const seen = new Map<string, number[]>();
  for (const f of figs) {
    for (const s of (f.reduction ?? '').split(/(?<=\.)\s+/).filter(Boolean)) {
      const hit = seen.get(s);
      if (hit) hit.push(f.no);
      else seen.set(s, [f.no]);
    }
  }
  return [...seen.entries()]
    .map(([s, nos]) => (figs.length > 1 && nos.length === 1 ? `${s.replace(/\.$/, '')} (Figure ${nos[0]}).` : s))
    .join(' ');
}
