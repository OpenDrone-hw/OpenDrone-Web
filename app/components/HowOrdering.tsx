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
 * /preorder with buy now or pre-order on: why pre-order, first. A few
 * reasons the company's own sources state, what happens to the order (the
 * dated stages of the campaign file), the buyer's rights when something goes
 * wrong (terms 2.9), then how to order: the stack in stock and everything on
 * pre-order. A visitor outside the EU sees the pre-order block alone.
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

  // Reasons, each from a source the company owns (PR #818 lists them).
  const shipMonthOf = (day: string) => new Intl.DateTimeFormat('en-GB', {month: 'long', year: 'numeric', timeZone: 'UTC'}).format(new Date(`${day}T12:00:00Z`));
  const reasons = [
    // Terms 2.9, art. 7bis.3bis; content/preorders.json `confirmed`.
    {key: 'confirmed', title: say('why_confirmed_title', 'Batch confirmed'), line: say('why_confirmed_line', 'The {month} batch is made whatever the number of orders.', {month: shipMonthOf(data.shipDay)})},
    // content/preorders.json `endsOn` and `afterEndsOn`.
    ...(earlyOpen && data.afterEndsOn === 'retail'
      ? [{key: 'early', title: say('why_early_title', 'Early bird price'), line: say('why_early_line', 'Under retail until {date}.', {date: ends})}]
      : []),
    // Batch 1: built and tested, shipped or in stock ready to ship (founder, 11 Nov 2026).
    {key: 'proven', title: say('why_proven_title', 'Done once already'), line: say('why_proven_line', 'Batch 1 is built and tested. It has shipped to EU customers and the rest is in stock.'), link: {to: '/testing', text: say('why_proven_link', 'How we test')}},
    // The OSHWA certification chips and /open-source.
    {key: 'open', title: say('why_open_title', 'Open and inspectable'), line: say('why_open_line', 'The designs are open source and OSHWA certified.'), link: {to: '/open-source', text: say('why_open_link', 'Open source')}},
  ];

  return (
    <div className="ho">
      <header className="ho-head">
        <h1 className="po-title">{say('why_title', 'Why pre-order?')}</h1>
        <p className="ho-lead">{say('why_lead', 'OpenDrone is open-source hardware, made in production batches. A pre-order is your place in the next batch.')}</p>
      </header>
      <ul className="ho-reasons">
        {reasons.map((reason) => (
          <li key={reason.key} className="ho-reason">
            <strong>{reason.title}</strong>
            <span>{reason.line}</span>
            {'link' in reason && reason.link ? (
              <Link to={reason.link.to} prefetch="intent" className="product-buy-terms-link">{reason.link.text}</Link>
            ) : null}
          </li>
        ))}
      </ul>
      <div className="ho-pair">
        <section className="ho-panel" aria-labelledby="ho-when">
          <h2 id="ho-when" className="ho-lane-title">{say('when_title', 'What happens to my order')}</h2>
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
        <section className="ho-panel is-trust" aria-labelledby="ho-wrong">
          <h2 id="ho-wrong" className="ho-lane-title">{say('wrong_title', 'If something goes wrong')}</h2>
          <ul className="ho-rights">
            <li>{say('wrong_cancel', 'Cancel any time before delivery: full refund.')}</li>
            <li>{say('wrong_late', 'Ship date missed: you choose a refund or to wait.')}</li>
          </ul>
          <Link to="/en/algemene-voorwaarden#art-7bis" className="product-buy-terms-link">{say('pay_terms', 'Pre-order terms')}</Link>
        </section>
      </div>
      <h2 className="ho-section-title">{say('how_title', 'How to order')}</h2>
      <div className={`ho-lanes${data.stacks.length ? '' : ' is-single'}`}>
        {data.stacks.length ? (
          <section className="ho-lane" aria-labelledby="ho-stock">
            <h3 id="ho-stock" className="ho-lane-title">{say('lane_stock_title', 'In stock: the {{stock_lines}} stack')}</h3>
            <p className="ho-line is-stock">{say('lane_stock_line', 'Ships in days from {{stock_from}}, {{stock_scope}} only')}</p>
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
          <h3 id="ho-preorder" className="ho-lane-title">{say('lane_preorder_title', 'Pre-order: everything')}</h3>
          <p className="ho-line">{say('lane_preorder_line', 'Every product, {{stock_lines}} included. Ships by {date}, worldwide.', {date: shipBy})}</p>
          <div className="ho-actions">
            <Link to="/products" prefetch="intent" className="hero-build-add">
              <span className="btn-label">{say('lane_preorder_cta', 'Pre-order from the products')}</span>
            </Link>
          </div>
        </section>
      </div>
      <p className="ho-line is-muted ho-pay-line">
        {[say('pay_full', 'Pay in full when you order.'), priceLine ? priceLine.replace(/\.?$/, '.') : null].filter(Boolean).join(' ')}
      </p>
    </div>
  );
}
