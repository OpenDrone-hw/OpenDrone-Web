import {Link, useRouteLoaderData} from 'react-router';
import {ShoppingBag} from 'lucide-react';
import {ExpressBuy, useExpressRefusal} from '~/components/ExpressBuy';
import {copyFill, copyText} from '~/lib/copy';
import {formatPrice} from '~/lib/catalog';
import {paysEuVat} from '~/lib/visitor-country';
import {shortCampaignDate, campaignDate} from '~/lib/preorder-campaign';

export type HowOrderingStack = {
  size: string;
  lines: Array<{sku: string; quantity: number}>;
  price: number;
  currency: string;
};

export type HowOrderingData = {
  /** The FC and ESC stacks this visitor can buy now: empty outside the EU
   *  or once batch 1 is gone, and the in-stock block is then absent. */
  stacks: HowOrderingStack[];
  /** ISO days from content/preorders.json: the early bird end, the ship-by date. */
  endsDay: string;
  shipDay: string;
  /** What happens after endsDay (content/preorders.json `afterEndsOn`). */
  afterEndsOn: 'closed' | 'retail' | 'earlyBird';
  /** The server's day, so the "Today" mark renders the same on hydration. */
  today: string;
  us: boolean;
  international: boolean;
};

const say = (key: string, fallback: string, vars: Record<string, string | number> = {}) =>
  copyFill(`preorder.${key}`, fallback, vars);

/**
 * /preorder with buy now or pre-order on: the one page that explains
 * ordering. Two blocks in the words of the home and product page (the stack
 * in stock, everything on pre-order), a short line of dated stages the
 * campaign file states, and what the buyer pays. A visitor outside the EU
 * sees the pre-order block alone.
 */
export function HowOrdering({data}: {data: HowOrderingData}) {
  const refusal = useExpressRefusal();
  const country = (useRouteLoaderData('root') as {visitorCountry?: string | null} | undefined)?.visitorCountry ?? null;
  const shipBy = campaignDate(data.shipDay);
  const ends = campaignDate(data.endsDay);
  const earlyOpen = data.today <= data.endsDay;
  const priceLine = data.us
    ? (copyText('product-chrome.buy_us_price_note') ?? 'Duties included')
    : data.international
      ? (copyText('product-chrome.buy_international_price_note') ?? 'Shipping and applicable sale taxes confirmed at checkout. Import charges may be payable on delivery.')
      : paysEuVat(country) || !country
        ? say('pay_vat', 'Prices include VAT')
        : null;
  // Only the dates the campaign file states: today, the early bird end
  // while it is ahead, the ship-by date.
  const stages = [
    {key: 'today', label: say('stage_today', 'Today'), day: data.today, now: true},
    ...(earlyOpen ? [{key: 'ends', label: say('stage_ends', 'Early bird ends'), day: data.endsDay, now: false}] : []),
    {key: 'ships', label: say('stage_ships', 'Ships by'), day: data.shipDay, now: false},
  ];

  return (
    <div className="ho">
      <h1 className="po-title">{say('how_title', 'How ordering works')}</h1>
      <div className={`ho-lanes${data.stacks.length ? '' : ' is-single'}`}>
        {data.stacks.length ? (
          <section className="ho-lane" aria-labelledby="ho-stock">
            <h2 id="ho-stock" className="ho-lane-title">{say('lane_stock_title', 'In stock: the FC and ESC stack')}</h2>
            <p className="ho-line is-stock">{say('lane_stock_line', 'Ships in days from Belgium, EU only')}</p>
            <div className="ho-actions">
              {data.stacks.map((stack) => (
                <ExpressBuy key={stack.size} lines={stack.lines} className="hero-build-add" product={`stack-${stack.size}-inch`}>
                  <ShoppingBag size={16} aria-hidden="true" />
                  {say('lane_stock_cta', 'Buy the {size}-inch stack now', {size: stack.size})}
                  <span className="hero-build-total">{formatPrice(stack.price.toFixed(2), stack.currency)}</span>
                </ExpressBuy>
              ))}
            </div>
            {refusal ? <p className="cart-line-error" role="alert">{refusal}</p> : null}
          </section>
        ) : null}
        <section className="ho-lane" aria-labelledby="ho-preorder">
          <h2 id="ho-preorder" className="ho-lane-title">{say('lane_preorder_title', 'Pre-order: everything')}</h2>
          <p className="ho-line">{say('lane_preorder_line', 'Every product, FC and ESC included. Ships by {date}, worldwide.', {date: shipBy})}</p>
          {earlyOpen && data.afterEndsOn === 'retail' ? (
            <p className="ho-line is-muted">{say('lane_preorder_price', 'Early bird price until {date}, then retail.', {date: ends})}</p>
          ) : null}
          <div className="ho-actions">
            <Link to="/products" prefetch="intent" className="hero-build-add">
              <span className="btn-label">{say('lane_preorder_cta', 'Pre-order from the products')}</span>
            </Link>
          </div>
          <ol className="ho-stages" aria-label={say('stages_aria', 'Pre-order dates')}>
            {stages.map((stage) => (
              <li key={stage.key} className={stage.now ? 'is-now' : undefined}>
                <span className="ho-stage-dot" aria-hidden="true" />
                <span className="ho-stage-label">{stage.label}</span>
                <time dateTime={stage.day}>{shortCampaignDate(campaignDate(stage.day)) ?? stage.day}</time>
              </li>
            ))}
          </ol>
        </section>
      </div>
      <section className="ho-pay" aria-labelledby="ho-pay">
        <h2 id="ho-pay" className="ho-lane-title">{say('pay_title', 'What you pay')}</h2>
        <ul>
          <li>{say('pay_full', 'Pay in full when you order.')}</li>
          {priceLine ? <li>{priceLine.replace(/\.?$/, '.')}</li> : null}
          <li>{say('pay_cancel', 'Cancel a pre-order any time before delivery, for a full refund.')}</li>
        </ul>
        <Link to="/terms" className="product-buy-terms-link">{say('pay_terms', 'Pre-order terms')}</Link>
      </section>
    </div>
  );
}
