import {useEffect, useId, useMemo, useRef, useState} from 'react';
import {useFetcher} from 'react-router';
import {copyText} from '~/lib/copy';
import {countryName, shipCountryPicker} from '~/lib/shipping-rates';
import {groupShipCountries} from '~/lib/ship-to-order';
import {CART_COUNTRY_ACTION, CART_UPDATED_EVENT, type CartCountryReply} from '~/lib/cart-client';

/**
 * The "Ship to" country selector of the cart page and the added-to-cart
 * dialog. It shows the destination the pages quote (the picked cookie, else
 * the visitor's country) and switches it through `/api/shopify/cart-country`:
 * the cookie, the cart's buyer country and every line's ship promise change
 * together, then the page reads the cart again in the new market.
 *
 * The usual destinations and the United States (while it is sold direct)
 * come first, then the rest of the EU, then everything else. Every country is listed; the ones not sold direct switch the cart page to
 * its retailer enquiry state, which offers no checkout.
 */
export function ShipToSelect({
  country,
  usRate,
  onChanged,
  onBusy,
  className = 'ship-to',
}: {
  /** The destination the page currently shows. */
  country: string | null;
  usRate: number | null;
  /** The reply of a successful switch, before the page reads again. */
  onChanged?: (reply: CartCountryReply) => void;
  onBusy?: (busy: boolean) => void;
  className?: string;
}) {
  const id = useId();
  // A route action: when it settles React Router reads every active loader
  // again, so the page behind (product page, listing) quotes the new market.
  const fetcher = useFetcher<CartCountryReply>();
  const busy = fetcher.state !== 'idle';
  const [value, setValue] = useState(country ?? '');
  const picker = useMemo(() => shipCountryPicker('en', usRate), [usRate]);
  const groups = useMemo(() => groupShipCountries(picker), [picker]);
  const failed = fetcher.state === 'idle' && Boolean(fetcher.data?.error);

  // Follow the page once nothing of ours is in flight.
  useEffect(() => {
    if (!busy) setValue(country ?? '');
  }, [country, busy]);

  // Report each change of state once, and the reply once it settles.
  const reported = useRef(false);
  useEffect(() => {
    if (busy === reported.current) return;
    reported.current = busy;
    onBusy?.(busy);
    if (busy) return;
    const reply = fetcher.data;
    if (!reply || reply.error) return;
    if (reply.summary) {
      window.dispatchEvent(
        new CustomEvent(CART_UPDATED_EVENT, {detail: {totalQuantity: reply.summary.totalQuantity}}),
      );
    }
    onChanged?.(reply);
  }, [busy, fetcher.data, onBusy, onChanged]);

  const change = (next: string) => {
    if (!next || next === country || busy) return;
    setValue(next);
    void fetcher.submit({country: next}, {method: 'post', action: CART_COUNTRY_ACTION});
  };

  // A destination the picker does not list (a blocked country from the IP)
  // still reads as the current value.
  const listed = country ? [...picker.likely, ...picker.rest].some((o) => o.code === country) : true;
  const group = (label: string, options: typeof groups.pinned) => (
    <optgroup label={label}>
      {options.map((option) => (
        <option key={option.code} value={option.code}>{option.name}</option>
      ))}
    </optgroup>
  );
  return (
    <div className={className} aria-busy={busy || undefined}>
      <label htmlFor={id} className="ship-to-label">
        {copyText('cart.ship_to_label') ?? 'Ship to'}
      </label>
      <select
        id={id}
        className="ship-to-select"
        value={value}
        disabled={busy}
        onChange={(event) => change(event.target.value)}
      >
        {!value ? <option value="">{copyText('cart.ship_to_pick') ?? 'Choose a country'}</option> : null}
        {!listed && country ? <option value={country}>{countryName(country)}</option> : null}
        {group(copyText('cart.ship_to_group_main') ?? 'Most orders', groups.pinned)}
        {group(copyText('cart.ship_to_group_eu') ?? 'European Union', groups.eu)}
        {group(copyText('cart.ship_to_group_world') ?? 'Other countries', groups.world)}
      </select>
      {failed ? (
        <small className="cart-line-error" role="alert">
          {copyText('cart.ship_to_failed') ?? 'Could not change the country. Try again.'}
        </small>
      ) : null}
    </div>
  );
}
