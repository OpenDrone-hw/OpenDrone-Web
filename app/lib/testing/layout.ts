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
