/**
 * The preorder step bar and ladder text for one campaign state. Pure, so the
 * node:test suites can check them without React.
 *
 * Relative imports on purpose: node:test runs this module without Vite.
 */

import type {CampaignState, LadderStep} from './preorder-campaign.ts';

export type MeterBar = {value: number; max: number; label: string};

type Lookup = (key: string) => string | undefined;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/**
 * The step bar of one SKU: units sold against the current batch (paid
 * stock) or funding target, "37 / 250", with a tick at each price-step end
 * that falls inside the bar. A batch that starts after sold-out batches
 * starts past the earlier price steps.
 */
export type StepBarView = {
  value: number;
  max: number;
  ticks: number[];
  funded: boolean;
  label: string;
  /** `paid`: a paid batch, `max` is its cap; `target`: a funding target. */
  kind: 'paid' | 'target';
};

export function stepBarView(state: CampaignState, stepEnds: number[]): StepBarView {
  const funded = !state.paidStock && state.targetReached;
  const max = state.paidStock ? state.batchUnits : (state.target ?? state.batchUnits);
  const counted = state.paidStock ? state.batchOrdered : state.targetOrdered;
  // Steps are shifted only by batches already sold out, so the bar reads the
  // same in every region: another region's units in a batch this buyer cannot
  // get never move its ticks.
  const offset = state.batches.filter((b) => b.status === 'sold_out').reduce((sum, b) => sum + b.units, 0);
  const value = funded ? max : Math.min(max, Math.max(0, counted));
  return {
    value,
    max,
    ticks: stepEnds.map((end) => end - offset).filter((end) => end > 0 && end < max),
    funded,
    label: `${value} / ${max}`,
    kind: state.paidStock ? 'paid' : 'target',
  };
}

/**
 * What a step bar's count means in words: a paid batch is a cap, "213 of
 * 250 left in batch 1"; a funding target is a goal, "37 / 250 target for
 * the March 2027 batch". `text` looks up the `preorder` copy.
 */
export function stepBarLabel(bar: StepBarView, batch: string | null = null, text: Lookup = () => undefined): string {
  const vars = {value: bar.value, max: bar.max, left: Math.max(0, bar.max - bar.value), batch: batch ?? ''};
  if (bar.kind === 'paid') {
    return fill(batch ? (text('meter_paid_left_in') ?? '{left} of {max} left in {batch}') : (text('meter_paid_left') ?? '{left} of {max} left'), vars);
  }
  return fill(batch ? (text('meter_target_for') ?? '{value} / {max} target for {batch}') : (text('meter_target') ?? '{value} / {max} target'), vars);
}

/**
 * The price steps a buyer of this state can still reach: a paid batch caps
 * what one buyer gets at its last unit, so a step that starts past it (251+
 * over a 250-unit paid batch) is not shown. Every step for a funding target.
 */
export function reachableSteps<T extends {from: number}>(state: CampaignState, steps: T[]): T[] {
  if (!state.paidStock || state.shipsWith) return steps;
  const last = state.batches.filter((b) => b.batch <= state.batch).reduce((sum, b) => sum + b.units, 0);
  return steps.filter((step) => step.from <= last);
}

/**
 * Where each price step starts along the step bar, in percent, so a step's
 * price sits over its own stretch of the bar. A step that starts past the
 * bar's end (251+ over a 250-unit batch) gets a tail after the bar: the
 * bar then takes `TRACK_SHARE` of the width. Null once the bar counts a
 * later batch or a reached target, where the steps no longer line up, and
 * when two steps would start closer than `MIN_STEP_GAP` percent apart (the
 * three steps inside the first quarter of a 1000-unit motor target): the
 * prices then sit in equal columns.
 */
export const TRACK_SHARE = 0.8;
const MIN_STEP_GAP = 25;

export function stepLayout(
  state: CampaignState,
  bar: StepBarView,
  froms: number[],
): {lefts: number[]; tail: boolean} | null {
  const counted = state.paidStock ? state.batchOrdered : state.targetOrdered;
  if (bar.funded || state.ordered - counted > 0 || bar.max <= 0 || !froms.length) return null;
  const tail = froms.some((from) => from > bar.max);
  const share = tail ? TRACK_SHARE : 1;
  const lefts = froms.map((from) => (Math.min(bar.max, from - 1) / bar.max) * share * 100);
  if (lefts.some((left, i) => i > 0 && left - lefts[i - 1] < MIN_STEP_GAP)) return null;
  return {lefts, tail};
}

/** 0 to 100, integer, clamped: a bar width that never reaches the DOM as NaN. */
export function barPercent(bar: MeterBar): number {
  if (!Number.isFinite(bar.value) || !Number.isFinite(bar.max) || bar.max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((bar.value / bar.max) * 100)));
}

/**
 * The price ladder as one line of plain text, for example "€31.20 for units
 * 1-100 · €35.10 for units 101-250 · €39.00 from unit 251". No struck-through
 * price: every step is a price the SKU really sells at.
 */
export function ladderText(
  steps: LadderStep[],
  format: (price: number) => string,
  text: Lookup = () => undefined,
): string {
  if (steps.length === 1) return format(steps[0].price);
  return steps
    .map((step) =>
      step.to === null
        ? fill(text('ladder_last') ?? '{price} from unit {from}', {
            price: format(step.price),
            from: step.from,
          })
        : fill(text('ladder_step') ?? '{price} for units {from}-{to}', {
            price: format(step.price),
            from: step.from,
            to: step.to,
          }),
    )
    .join(' · ');
}
