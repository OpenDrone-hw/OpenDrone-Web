import {useEffect, useId, useMemo, useState} from 'react';
import {useRevalidator} from 'react-router';
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
  // A plain POST, not a router fetcher: any failure (an error reply, a
  // proxy error page, a dropped connection) stays a message under the
  // select. Through a fetcher a non-JSON reply replaced the page with the
  // error screen. A switch that lands reads every active loader again, so
  // the page behind quotes the new market.
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [value, setValue] = useState(country ?? '');
  const picker = useMemo(() => shipCountryPicker('en', usRate), [usRate]);
  const groups = useMemo(() => groupShipCountries(picker), [picker]);

  // Follow the page once nothing of ours is in flight.
  useEffect(() => {
    if (!busy) setValue(country ?? '');
  }, [country, busy]);

  const change = async (next: string) => {
    if (!next || next === country || busy) return;
    setValue(next);
    setBusy(true);
    setFailed(false);
    onBusy?.(true);
    try {
      const response = await fetch(CART_COUNTRY_ACTION, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({country: next}),
        credentials: 'same-origin',
      });
      const reply = (await response.json().catch(() => null)) as CartCountryReply | null;
      if (!response.ok || !reply || reply.error) throw new Error('ship-to switch failed');
      if (reply.summary) {
        window.dispatchEvent(
          new CustomEvent(CART_UPDATED_EVENT, {detail: {totalQuantity: reply.summary.totalQuantity}}),
        );
      }
      onChanged?.(reply);
      await revalidator.revalidate();
    } catch {
      setFailed(true);
      setValue(country ?? '');
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
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
        onChange={(event) => void change(event.target.value)}
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
