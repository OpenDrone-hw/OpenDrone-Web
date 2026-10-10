import {unitLabel} from './scale.ts';
import type {AxisDef, Fig} from './types.ts';

/**
 * Editorial choices of the workspace that are not in the figure files: which
 * figure a panel duplicates, and the one place an assumption is written.
 */

/** A hold panel that repeats a figure drawn in full elsewhere is not stacked. */
export const DUPLICATE_OF: Record<string, string> = {
  'openmotor-hold-rpm': 'openmotor-thrust-vs-rpm',
};

/** Where a figure's own anchor is, when its panel is not drawn: links go to the figure that shows it. */
export const anchorFor = (id: string): string => DUPLICATE_OF[id] ?? id;

/** The pole-pair assumption is stated once, in the axis title, not in every card. */
const AXIS_NOTE: Record<string, Partial<Record<'x' | 'y' | 'y2', string>>> = {
  'openmotor-thrust-vs-rpm': {x: '7 pole pairs assumed'},
  'openmotor-hold-rpm': {y: '7 pole pairs assumed'},
};

export function axisTitle(fig: Fig, axis: 'x' | 'y' | 'y2'): string {
  const a: AxisDef | undefined = fig.axes[axis];
  if (!a) return '';
  const note = AXIS_NOTE[fig.id]?.[axis];
  return `${a.label} (${unitLabel(a.unit)}${note ? `, ${note}` : ''})`;
}

/** A flagged caveat too long for one line under a card has a short form here; the full text stays in Details. */
export const SHORT_FLAG: Record<string, string> = {
  'openmotor-thrust-vs-rpm': 'Pack A stops at 70 percent: 0 V pack voltage, cause not recorded.',
  'openmotor-hold-thrust': 'At 10 percent throttle the two packs read 30 g and 35 g.',
};

/** Caveats the axis title already states; they are not repeated under the card. */
const STATED_IN_AXIS = /assumes 7 pole pairs/;

/** The one caveat shown under a card: the first flagged one the axis does not already state. */
export function visibleCaveat(figs: Fig[]): {text: string; full: string} | null {
  for (const f of figs) {
    for (const c of f.caveats) {
      const text = typeof c === 'string' ? c : c.text;
      const flagged = typeof c !== 'string' && c.flag === true;
      if (!flagged || STATED_IN_AXIS.test(text)) continue;
      const short = SHORT_FLAG[f.id];
      const isShortable = short && f.caveats.length;
      return {text: isShortable ? short : text, full: text};
    }
  }
  return null;
}
