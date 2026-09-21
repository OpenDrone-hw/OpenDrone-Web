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
  return (
    <div className={`preorder-meter${compact ? ' is-compact' : ''}`}>
      <p className="preorder-meter-headline">{view.headline}</p>
      <Bar bar={view.bar} />
      {view.stretch ? (
        <>
          <p className="preorder-meter-stretch">{view.stretch.label}</p>
          <Bar bar={view.stretch} thin />
        </>
      ) : null}
      {view.early && !compact ? <p className="preorder-meter-early">{view.early}</p> : null}
      {compact ? null : (
        <Link className="preorder-meter-link" prefetch="intent" to="/preorder">
          {copyText('preorder.meter_link') ?? 'How preorders work'}
        </Link>
      )}
    </div>
  );
}

function Bar({bar, thin = false}: {bar: MeterBar; thin?: boolean}) {
  const pct = barPercent(bar);
  return (
    <div
      className={`preorder-meter-bar${thin ? ' is-thin' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={bar.label}
    >
      <span style={{width: `${pct}%`}} />
    </div>
  );
}
