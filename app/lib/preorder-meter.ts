/**
 * What a preorder meter says for one campaign state: the headline, the bar
 * and the optional stretch line. Pure, so the node:test suites can check the
 * wording rules without React. Words come from `content/copy/preorder.json`
 * through the `text` lookup; the fallbacks keep a missing key readable.
 *
 * Relative imports on purpose: node:test runs this module without Vite.
 */

import type {CampaignState, LadderStep} from './preorder-campaign.ts';

export type MeterBar = {value: number; max: number; label: string};

export type MeterView = {
  /** The one-line status: paid stock left, progress to the target, or reached. */
  headline: string;
  /** Which meter this is: paid stock, a funding target still open, or a
   *  reached target. Use this, not `bar`, to style the meter: an open
   *  target with no orders yet has no bar. */
  state: 'stock' | 'open' | 'funded';
  /** The main bar; none for paid stock, where "units left" says it all,
   *  and none for a funding target nobody has ordered toward yet. */
  bar: MeterBar | null;
  /** The funding target is reached: the bar reads as done. */
  reached: boolean;
  /** After the target: the next batch filling, as a second, thinner bar. */
  stretch: MeterBar | null;
  /** "Preorder price for the first 100 · 43 left, then €X", when it applies. */
  early: string | null;
};

type Lookup = (key: string) => string | undefined;

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function meterView(
  state: CampaignState,
  text: Lookup,
  priceAfter?: string | null,
): MeterView {
  const t = (key: string, fallback: string, vars: Record<string, string | number>) =>
    fill(text(key) ?? fallback, vars);

  const early =
    state.earlyPrice && priceAfter
      ? t('meter_early', 'Preorder price for the first {units} · {left} left, then {price}', {
          units: state.tierUpTo ?? 0,
          left: state.tierLeft,
          price: priceAfter,
        })
      : null;

  if (state.paidStock) {
    const left = state.batchUnits - state.batchOrdered;
    return {
      state: 'stock',
      headline: t('meter_paid', 'Batch {batch} is paid for and in production · {left} of {units} left', {
        batch: state.batch,
        left,
        units: state.batchUnits,
      }),
      bar: null,
      reached: false,
      stretch: null,
      early,
    };
  }

  if (state.target !== null && !state.targetReached && state.targetOrdered < 1) {
    // Nothing ordered yet: lead with the target and its deadline, not an
    // empty bar and "0 of 1000", which reads as a campaign going nowhere.
    return {
      state: 'open',
      headline: state.deadline
        ? t('meter_target_zero', 'Funding target: {target} units by {deadline}. Orders so far: {ordered}', {
            target: state.target,
            deadline: state.deadline,
            ordered: 0,
          })
        : t('meter_target_zero_nodate', 'Funding target: {target} units. Orders so far: {ordered}', {
            target: state.target,
            ordered: 0,
          }),
      bar: null,
      reached: false,
      stretch: null,
      early,
    };
  }

  if (state.target !== null && !state.targetReached) {
    return {
      state: 'open',
      headline: t('meter_target', '{ordered} of {target} ordered toward the funding target', {
        ordered: state.targetOrdered,
        target: state.target,
      }),
      bar: {
        value: state.targetOrdered,
        max: state.target,
        label: t('meter_target_bar', '{ordered} of {target} ordered', {
          ordered: state.targetOrdered,
          target: state.target,
        }),
      },
      reached: false,
      stretch: null,
      early,
    };
  }

  const target = state.target ?? state.batchUnits;
  return {
    state: 'funded',
    headline: t('meter_reached', 'Funding target reached · {ordered} ordered', {
      ordered: state.ordered,
    }),
    bar: {
      value: target,
      max: target,
      label: t('meter_target_bar', '{ordered} of {target} ordered', {
        ordered: target,
        target,
      }),
    },
    reached: true,
    stretch: {
      value: state.batchOrdered,
      max: state.batchUnits,
      label: t('meter_next', 'Batch {batch}: {ordered} of {units}', {
        batch: state.batch,
        ordered: state.batchOrdered,
        units: state.batchUnits,
      }),
    },
    early,
  };
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
