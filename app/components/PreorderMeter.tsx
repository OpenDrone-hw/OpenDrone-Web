import {Link} from 'react-router';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import type {CampaignState} from '~/lib/preorder-campaign';
import type {MoneyV2} from '~/lib/product-shapes';
import {barPercent, meterView, type MeterBar, type StepBarView} from '~/lib/preorder-meter';

/**
 * The preorder campaign meter for one SKU: paid stock left, or progress to
 * its funding target, then the next batch filling. Words come from
 * `content/copy/preorder.json`; the numbers are computed server-side in the
 * catalog client, so the server render and hydration agree.
 *
 * `StepBar` below is the short form: units sold as one bar with the
 * price-step ends ticked, "37 / 250".
 */
export function PreorderMeter({
  campaign,
  priceAfter,
  showEarly = true,
  showBatchPromise = true,
  showBatches = true,
  zeroLabel,
}: {
  campaign: CampaignState;
  /** Shopify's compare-at price: the price once the target is reached. */
  priceAfter?: MoneyV2 | null;
  /** The "preorder price for the first N" line. The product page turns it
   *  off where it shows the whole price ladder instead. */
  showEarly?: boolean;
  /** The current batch row repeats the ship promise. The product page
   *  turns it off where the ship promise already sits on the stock line. */
  showBatchPromise?: boolean;
  /** The per-batch list. The product page turns it off: the batches are
   *  explained on /preorder, behind the "How preorders work" link. */
  showBatches?: boolean;
  /** Shown instead of an empty bar and "0 of N" before the first order
   *  counts toward a funding target ("Funding target: 250 by 31 December
   *  2026"). Unset, the bar shows as it is. */
  zeroLabel?: string;
}) {
  const view = meterView(
    campaign,
    (key) => copyText(`preorder.${key}`),
    priceAfter ? formatPrice(priceAfter.amount, priceAfter.currencyCode) : null,
  );
  const state = view.reached ? 'funded' : view.bar ? 'open' : 'stock';
  if (
    zeroLabel &&
    !view.reached &&
    !campaign.paidStock &&
    (view.bar ? view.bar.value : campaign.targetOrdered) <= 0
  ) {
    return (
      <div className="funding-meter preorder-meter" data-funding-state="zero">
        <span className="funding-meter-status">{zeroLabel}</span>
        <Link className="funding-meter-link" prefetch="intent" to="/preorder">
          {copyText('preorder.meter_link') ?? 'How preorders work'}
        </Link>
      </div>
    );
  }
  return (
    <div className="funding-meter preorder-meter" data-funding-state={state}>
      {view.bar ? <Bar bar={view.bar} /> : null}
      <span className="funding-meter-status">{view.headline}</span>
      {view.stretch ? (
        <>
          <Bar bar={view.stretch} thin />
          <span className="funding-meter-label">{view.stretch.label}</span>
        </>
      ) : null}
      {showEarly && view.early ? (
        <span className="funding-meter-label">{view.early}</span>
      ) : null}
      {showBatches && campaign.batches.length > 1 ? (
        <ol className="funding-meter-batches">
          {campaign.batches.map((b) => (
            <li key={b.batch} data-batch-status={b.status}>
              <span>{(copyText('preorder.batch_label') ?? 'Batch {batch}').replace('{batch}', String(b.batch))}</span>
              <span>
                {b.status === 'sold_out'
                  ? copyText('preorder.batch_sold_out') ?? 'sold out'
                  : b.status === 'current'
                    ? showBatchPromise
                      ? b.shipPromise
                      : campaign.paidStock
                        ? (copyText('preorder.batch_current_paid') ?? '{units} units, paid stock').replace('{units}', String(b.units))
                        : (copyText('preorder.batch_current_target') ?? '{units} units, taking preorders').replace('{units}', String(b.units))
                    : (copyText('preorder.batch_next') ?? 'next, {units} units').replace('{units}', String(b.units))}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <Link className="funding-meter-link" prefetch="intent" to="/preorder">
        {copyText('preorder.meter_link') ?? 'How preorders work'}
      </Link>
    </div>
  );
}

function Bar({bar, thin = false}: {bar: MeterBar; thin?: boolean}) {
  const pct = barPercent(bar);
  return (
    <span
      className={`funding-meter-track${thin ? ' is-thin' : ''}`}
      role="progressbar"
      aria-label={bar.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={bar.label}
    >
      {/* Nothing counted yet: no fill at all, not a sliver. */}
      <span
        className="funding-meter-fill"
        data-empty={bar.value > 0 ? undefined : ''}
        style={{width: `${pct}%`}}
      />
    </span>
  );
}

/**
 * Units sold as one bar: the fill is units sold, a tick marks each price-step
 * end inside the bar, the label is "37 / 250" (or `fundedLabel` once a
 * target is reached). `prices` is the step price row above the bar, the
 * current step marked.
 */
export function StepBar({
  bar,
  prices = [],
  fundedLabel,
}: {
  bar: StepBarView;
  prices?: Array<{key: string | number; text: string; current: boolean}>;
  fundedLabel?: string;
}) {
  const pct = barPercent(bar);
  const label = bar.funded && fundedLabel ? fundedLabel : bar.label;
  return (
    <div className="step-bar" data-funded={bar.funded ? '' : undefined}>
      {prices.length > 1 ? (
        <ol className="step-bar-prices">
          {prices.map((p) => (
            <li key={p.key} aria-current={p.current ? 'true' : undefined}>
              {p.text}
            </li>
          ))}
        </ol>
      ) : null}
      <span
        className="step-bar-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={bar.max}
        aria-valuenow={bar.value}
        aria-valuetext={label}
      >
        <span className="step-bar-fill" style={{width: `${pct}%`}} />
        {bar.ticks.map((tick) => (
          <span key={tick} className="step-bar-tick" style={{left: `${(tick / bar.max) * 100}%`}} />
        ))}
      </span>
      <span className="step-bar-label">{label}</span>
    </div>
  );
}
