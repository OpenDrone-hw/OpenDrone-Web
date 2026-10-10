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
 * The one caveat shown under a card. The view's `card_caveat` decides: its
 * text, or nothing when it is empty; without it, the first flagged caveat in
 * full. The full caveats stay in Details.
 */
export function visibleCaveat(figs: Fig[]): {text: string; full: string} | null {
  for (const f of figs) {
    const flagged = f.caveats.map((c) => (typeof c === 'string' ? null : c.flag ? c.text : null)).find((t) => t);
    if (f.cardCaveat !== undefined) {
      if (f.cardCaveat && flagged) return {text: f.cardCaveat, full: flagged};
      if (f.cardCaveat) return {text: f.cardCaveat, full: f.cardCaveat};
      continue;
    }
    if (flagged) return {text: flagged, full: flagged};
  }
  return null;
}
