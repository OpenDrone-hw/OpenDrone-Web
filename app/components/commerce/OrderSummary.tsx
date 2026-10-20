import {useState} from 'react';
import {useFetcher} from 'react-router';
import {type Quote, formatMoney} from '~/lib/commerce/app-api';
import {DiscountCode, FreeShippingBar, OrderNote, PickupChoice} from './SummaryOptions';
import {SummarySuggestions} from './SummarySuggestions';

export type SummaryImages = Record<string, {url: string; alt: string} | null>;

function Stepper({variant, qty}: {variant: string; qty: number}) {
  const fetcher = useFetcher();
  const next = (n: number) => ({intent: 'qty', variant, qty: String(n)});
  return (
    <div className="co-qty" aria-label="Quantity">
      <button type="button" aria-label="One less" disabled={qty <= 1} onClick={() => void fetcher.submit(next(qty - 1), {method: 'post'})}>
        <span aria-hidden="true">&minus;</span>
      </button>
      <output aria-live="polite">{qty}</output>
      <button type="button" aria-label="One more" disabled={qty >= 20} onClick={() => void fetcher.submit(next(qty + 1), {method: 'post'})}>
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}

function Remove({variant, title}: {variant: string; title: string}) {
  const fetcher = useFetcher();
  return (
    <button type="button" className="co-remove" aria-label={`Remove ${title}`} onClick={() => void fetcher.submit({intent: 'remove', variant}, {method: 'post'})}>
      Remove
    </button>
  );
}

/** The order summary column: lines with picture, quantity stepper and remove, then the money rows. On a phone it
 *  folds into a "Show order summary" bar with the total. */
export function OrderSummary({quote, country, images, pending, code = ''}: {quote: Quote; country: string; images: SummaryImages; pending: boolean; code?: string}) {
  const [open, setOpen] = useState(false);
  const money = (n: number) => formatMoney(n, quote.currency);
  return (
    <div className="co-side">
      <aside className="co-summary" aria-label="Order summary" data-open={open} aria-busy={pending}>
        <button type="button" className="co-summary-bar" aria-expanded={open} aria-controls="co-summary-body" onClick={() => setOpen(!open)}>
          <span>{open ? 'Hide order summary' : 'Show order summary'}</span>
          <span className="co-summary-bar-total">{money(quote.total_minor)}</span>
        </button>
        <div id="co-summary-body" className="co-summary-body">
          <ul className="co-lines">
            {quote.lines.map((l) => {
              const img = images[l.variant];
              return (
                <li key={l.variant} className="co-line">
                  <span className="co-thumb">
                    {img ? <img src={img.url} alt="" width={64} height={64} loading="lazy" /> : null}
                    <span className="co-badge" aria-hidden="true">
                      {l.qty}
                    </span>
                  </span>
                  <span className="co-line-text">
                    <span className="co-line-title">{l.title}</span>
                    {l.variant_title && l.variant_title !== 'Default Title' ? <span className="co-dim">{l.variant_title}</span> : null}
                    <span className="co-line-tools">
                      <Stepper variant={l.variant} qty={l.qty} />
                      <Remove variant={l.variant} title={l.title} />
                    </span>
                  </span>
                  <span className="co-num">{money(l.total_minor)}</span>
                </li>
              );
            })}
          </ul>
          <FreeShippingBar quote={quote} />
          <DiscountCode quote={quote} code={code} />
          <PickupChoice quote={quote} />
          <OrderNote />
          <dl className="co-totals">
            <div>
              <dt>Subtotal</dt>
              <dd className="co-num">{money(quote.subtotal_minor)}</dd>
            </div>
            {quote.discount && quote.discount.minor > 0 ? (
              <div>
                <dt>Discount ({quote.discount.code})</dt>
                <dd className="co-num">&minus;{money(quote.discount.minor)}</dd>
              </div>
            ) : null}
            <div>
              <dt>{quote.pickup ? 'Pickup at our Leuven office' : `Shipping to ${country}`}</dt>
              <dd className="co-num">{quote.shipping_minor === 0 ? 'Free' : money(quote.shipping_minor)}</dd>
            </div>
            <div className="co-grand">
              <dt>Total</dt>
              <dd className="co-num">
                <span className="co-dim">{quote.currency}</span> {money(quote.total_minor)}
              </dd>
            </div>
            <div className="co-vat">
              <dt>Includes VAT ({quote.vat_rate}%)</dt>
              <dd className="co-num">{money(quote.vat_included_minor)}</dd>
            </div>
          </dl>
        </div>
      </aside>
      <SummarySuggestions skus={quote.lines.map((l) => l.sku ?? '').filter(Boolean)} />
    </div>
  );
}

