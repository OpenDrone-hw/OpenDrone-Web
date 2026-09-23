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
 * that falls inside the bar. Ticks only while the bar counts from unit 1:
 * a later batch starts past the price steps.
 */
export type StepBarView = {value: number; max: number; ticks: number[]; funded: boolean; label: string};

export function stepBarView(state: CampaignState, stepEnds: number[]): StepBarView {
  const funded = !state.paidStock && state.targetReached;
  const max = state.paidStock ? state.batchUnits : (state.target ?? state.batchUnits);
  const counted = state.paidStock ? state.batchOrdered : state.targetOrdered;
  const offset = Math.max(0, state.ordered - counted);
  const value = funded ? max : Math.min(max, Math.max(0, counted));
  return {
    value,
    max,
    ticks: stepEnds.map((end) => end - offset).filter((end) => end > 0 && end < max),
    funded,
    label: `${value} / ${max}`,
  };
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
