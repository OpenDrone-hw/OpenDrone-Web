import {useEffect, useRef, useState} from 'react';
import {useFetcher} from 'react-router';
import {type Quote, formatMoney, vatLabel} from '~/lib/commerce/app-api';
import {DiscountCode, FreeShippingBar, OrderNote, PickupChoice} from './SummaryOptions';
import {discountRows, lineStrike, shippingStrike} from '~/lib/commerce/summary-discounts';
import {SummarySuggestions} from './SummarySuggestions';
import {ShipChip, parcelPromise} from '~/components/ShipChip';
import {EarlyBirdNote, useAnyEarlySku} from '~/components/EarlyPriceCue';
import {type CartChange, changeText} from '~/lib/commerce/app-cart-seen';
import {countryName} from '~/lib/shipping-rates';

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
/** True while the element fits in the viewport below the sticky header, so the summary column may stick; a taller
 *  column (many lines, add-ons, a build) flows with the page instead of becoming its own scroll area. */
function useFitsViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-height')) || 80;
      setValue(el.scrollHeight + header + 48 <= window.innerHeight);
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    window.addEventListener('resize', check);
    check();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', check);
    };
  }, []);
  return {ref, value};
}

export function OrderSummary({quote, country, images, pending, code = '', changes = []}: {quote: Quote; country: string; images: SummaryImages; pending: boolean; code?: string; changes?: CartChange[]}) {
  // A quote change the buyer has not seen stays on screen while they edit the cart (the page reloads its data).
  const [noted, setNoted] = useState<CartChange[]>([]);
  useEffect(() => {
    if (changes.length) setNoted((old) => [...old.filter((o) => !changes.some((c) => c.variant === o.variant && c.kind === o.kind)), ...changes]);
  }, [changes]);
  // As the Shopify-mode cart: one parcel ships when its last item is ready, and early bird prices say so once.
  const parcel = parcelPromise(quote.lines.map((l) => l.ship_promise));
  const anyEarly = useAnyEarlySku(quote.lines.map((l) => l.sku));
  const [open, setOpen] = useState(false);
  const fits = useFitsViewport();
  const money = (n: number) => formatMoney(n, quote.currency);
  const shipStrike = shippingStrike(quote);
  return (
    <div className="co-side" ref={fits.ref} data-fits={fits.value || undefined}>
      <aside className="co-summary" aria-label="Order summary" data-open={open} aria-busy={pending}>
        <button type="button" className="co-summary-bar" aria-expanded={open} aria-controls="co-summary-body" onClick={() => setOpen(!open)}>
          <span>{open ? 'Hide order summary' : 'Show order summary'}</span>
          <span className="co-summary-bar-total">{money(quote.total_minor)}</span>
        </button>
        <div id="co-summary-body" className="co-summary-body">
          {noted.length ? (
            <div role="status" className="co-changed">
              <p>Since you last looked:</p>
              <ul>
                {noted.map((c) => (
                  <li key={`${c.variant}:${c.kind}`}>{changeText(c)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ul className="co-lines">
            {quote.lines.map((l) => {
              const img = images[l.variant];
              const strike = lineStrike(l);
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
                    {l.sale_mode === 'preorder' && l.ship_promise ? <span className="co-dim">Preorder: {l.ship_promise}</span> : null}
                    <span className="co-line-tools">
                      <Stepper variant={l.variant} qty={l.qty} />
                      <Remove variant={l.variant} title={l.title} />
                    </span>
                  </span>
                  <span className="co-num">
                    {strike ? (
                      <>
                        <s className="co-dim co-was">{money(strike.was)}</s> {money(strike.now)}
                      </>
                    ) : (
                      money(l.total_minor)
                    )}
                  </span>
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
            {discountRows(quote).map((r) => (
              <div key={r.key}>
                <dt className="co-disc">
                  <TagIcon />
                  {r.label}
                </dt>
                <dd className="co-num">&minus;{money(r.minor)}</dd>
              </div>
            ))}
            <div>
              <dt>{quote.pickup ? 'Pickup at our Leuven office' : `Shipping to ${countryName(country)}`}</dt>
              <dd className="co-num">
                {shipStrike != null ? (
                  <>
                    <s className="co-dim co-was">{money(shipStrike)}</s>{' '}
                  </>
                ) : null}
                {quote.shipping_minor === 0 ? 'Free' : money(quote.shipping_minor)}
              </dd>
            </div>
            <div className="co-grand">
              <dt>Total</dt>
              <dd className="co-num">
                <span className="co-dim">{quote.currency}</span> {money(quote.total_minor)}
              </dd>
            </div>
            <div className="co-vat">
              <dt>{vatLabel(quote)}</dt>
              <dd className="co-num">{money(quote.vat_included_minor)}</dd>
            </div>
          </dl>
          {parcel ? (
            <p className="co-parcel">
              <span className="co-dim">Your parcel</span>
              <ShipChip promise={parcel} ifFunded />
            </p>
          ) : null}
          {quote.parcels && quote.parcels.length > 1 ? (
            <ul className="co-parcels" aria-label="Parcels">
              {quote.parcels.map((p, i) => (
                <li key={i}>
                  <span className="co-dim">Parcel {i + 1}{p.titles?.length ? `: ${p.titles.join(', ')}` : ''}</span>
                  {p.ship_promise ? <ShipChip promise={p.ship_promise} ifFunded /> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <EarlyBirdNote show={anyEarly} className="cart-summary-note" />
        </div>
      </aside>
      <SummarySuggestions skus={quote.lines.map((l) => l.sku ?? '').filter(Boolean)} />
    </div>
  );
}

/** The tag in front of a discount row, as checkouts mark a saving; drawn in the text colour. */
function TagIcon() {
  return (
    <svg className="co-disc__tag" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M8.6 1.5H14a.5.5 0 0 1 .5.5v5.4a1 1 0 0 1-.3.7l-6.6 6.6a1 1 0 0 1-1.4 0L1.3 9.8a1 1 0 0 1 0-1.4l6.6-6.6a1 1 0 0 1 .7-.3Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="11.2" cy="4.8" r="1.1" fill="currentColor" />
    </svg>
  );
}
