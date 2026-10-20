import {useState} from 'react';
import {useFetcher} from 'react-router';
import {type Quote, formatMoney} from '~/lib/commerce/app-api';
import '../../styles/cart-parity.css';

/** The checkout form these fields belong to (`shop.cart.tsx`): the inputs sit in the summary column, outside the
 *  <form>, and join it by id. */
const FORM = 'checkout';

/** Progress to free shipping, when the app offers a threshold. Nothing is shown without one. */
export function FreeShippingBar({quote}: {quote: Quote}) {
  const f = quote.free_shipping;
  if (!f || quote.pickup) return null;
  const reached = f.remaining_minor <= 0;
  const share = Math.min(100, Math.round(((f.threshold_minor - f.remaining_minor) / f.threshold_minor) * 100));
  return (
    <div className="co-free" role="status">
      <p className="co-free-text">
        {reached ? 'Shipping is free on this order.' : `Add ${formatMoney(f.remaining_minor, quote.currency)} more for free shipping.`}
      </p>
      <div className="co-free-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} aria-label="Progress to free shipping">
        <span style={{width: `${share}%`}} />
      </div>
    </div>
  );
}

/** Discount code: apply, see what it takes off, remove. The app validates it; its problem text is shown as it is. */
export function DiscountCode({quote, code}: {quote: Quote; code: string}) {
  const fetcher = useFetcher();
  const [value, setValue] = useState('');
  const applied = quote.discount;
  const busy = fetcher.state !== 'idle';
  const send = (next: string) => void fetcher.submit({intent: 'discount', code: next}, {method: 'post'});
  return (
    <div className="co-code">
      {applied ? (
        <p className="co-code-applied">
          <span className="co-code-chip">{applied.code}</span>
          <button type="button" className="co-remove" aria-label={`Remove code ${applied.code}`} disabled={busy} onClick={() => send('')}>
            Remove
          </button>
        </p>
      ) : (
        <form
          className="co-code-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) send(value.trim());
          }}
        >
          <label className="co-code-label" htmlFor="co-code-input">
            Discount code
          </label>
          <input id="co-code-input" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} />
          <button type="submit" disabled={busy || !value.trim()}>
            Apply
          </button>
        </form>
      )}
      {!applied && code && quote.discount_problem ? (
        <p className="co-code-problem" role="alert">
          {quote.discount_problem}
        </p>
      ) : null}
      {applied ? <input type="hidden" name="discount_code" value={applied.code} form={FORM} /> : null}
    </div>
  );
}

/** Collect the order at the office instead of shipping it, where the app offers it. */
export function PickupChoice({quote}: {quote: Quote}) {
  const fetcher = useFetcher();
  if (!quote.pickup_available) return null;
  const on = Boolean(quote.pickup);
  return (
    <div className="co-pickup">
      <label>
        <input type="checkbox" checked={on} disabled={fetcher.state !== 'idle'} onChange={(e) => void fetcher.submit({intent: 'pickup', on: e.target.checked ? '1' : ''}, {method: 'post'})} />
        <span>
          Pick up at our Leuven office, free
          {quote.shipping_standard_minor ? <em> (saves {formatMoney(quote.shipping_standard_minor, quote.currency)})</em> : null}
        </span>
      </label>
      {on ? <input type="hidden" name="pickup" value="1" form={FORM} /> : null}
    </div>
  );
}

/** A note to the shop, sent with the order. */
export function OrderNote() {
  return (
    <label className="co-note">
      <span>
        Note to the shop <em>(optional)</em>
      </span>
      <textarea name="note" form={FORM} rows={2} maxLength={500} />
    </label>
  );
}
