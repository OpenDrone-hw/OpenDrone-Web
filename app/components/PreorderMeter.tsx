import {Link} from 'react-router';
import {copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import type {CampaignState} from '~/lib/preorder-campaign';
import type {MoneyV2} from '~/lib/product-shapes';
import {barPercent, meterView, type MeterBar} from '~/lib/preorder-meter';

/**
 * The preorder campaign meter for one SKU: paid stock left, or progress to
 * its funding target, then the next batch filling. Words come from
 * `content/copy/preorder.json`; the numbers are computed server-side in the
 * catalog client, so the server render and hydration agree.
 *
 * `compact` is the tracker row: bar and short count only.
 */
export function PreorderMeter({
  campaign,
  priceAfter,
  compact = false,
}: {
  campaign: CampaignState;
  /** Shopify's compare-at price: the price once the target is reached. */
  priceAfter?: MoneyV2 | null;
  compact?: boolean;
}) {
  const view = meterView(
    campaign,
    (key) => copyText(`preorder.${key}`),
    priceAfter ? formatPrice(priceAfter.amount, priceAfter.currencyCode) : null,
  );
  const state = view.reached ? 'funded' : view.bar ? 'open' : 'stock';
  if (compact) {
    return (
      <div className="funding-meter is-compact" data-funding-state={state}>
        {view.bar ? <Bar bar={view.bar} /> : null}
        <span className="funding-meter-label">{view.bar ? view.bar.label : view.count}</span>
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
      {view.early ? <span className="funding-meter-label">{view.early}</span> : null}
      {campaign.batches.length > 1 ? (
        <ol className="funding-meter-batches">
          {campaign.batches.map((b) => (
            <li key={b.batch} data-batch-status={b.status}>
              <span>{(copyText('preorder.batch_label') ?? 'Batch {batch}').replace('{batch}', String(b.batch))}</span>
              <span>
                {b.status === 'sold_out'
                  ? copyText('preorder.batch_sold_out') ?? 'sold out'
                  : b.status === 'current'
                    ? b.shipPromise
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
      <span className="funding-meter-fill" style={{width: `${pct}%`}} />
    </span>
  );
}
