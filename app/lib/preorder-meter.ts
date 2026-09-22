/**
 * What a preorder meter says for one campaign state: the headline, the bar
 * and the optional stretch line. Pure, so the node:test suites can check the
 * wording rules without React. Words come from `content/copy/preorder.json`
 * through the `text` lookup; the fallbacks keep a missing key readable.
 *
 * Relative imports on purpose: node:test runs this module without Vite.
 */

import type {CampaignState} from './preorder-campaign.ts';

export type MeterBar = {value: number; max: number; label: string};

export type MeterView = {
  /** The one-line status: paid stock left, progress to the target, or reached. */
  headline: string;
  /** The main bar; none for paid stock, where "units left" says it all. */
  bar: MeterBar | null;
  /** The funding target is reached: the bar reads as done. */
  reached: boolean;
  /** Short count for a compact row: "187 / 250", "143 left". */
  count: string;
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
      headline: t('meter_paid', 'Batch {batch} is paid for and in production · {left} of {units} left', {
        batch: state.batch,
        left,
        units: state.batchUnits,
      }),
      bar: null,
      reached: false,
      count: t('meter_paid_count', '{left} left', {left}),
      stretch: null,
      early,
    };
  }

  if (state.target !== null && !state.targetReached) {
    return {
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
      count: `${state.targetOrdered} / ${state.target}`,
      stretch: null,
      early,
    };
  }

  const target = state.target ?? state.batchUnits;
  return {
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
    count: t('meter_reached_count', '{ordered} ordered', {ordered: state.ordered}),
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

/** 0 to 100, integer, clamped: a bar width that never reaches the DOM as NaN. */
export function barPercent(bar: MeterBar): number {
  if (!Number.isFinite(bar.value) || !Number.isFinite(bar.max) || bar.max <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((bar.value / bar.max) * 100)));
}
