import {useEffect, useId, useRef, useState} from 'react';
import {useFetcher, useRevalidator, useRouteLoaderData} from 'react-router';
import {copyText} from '~/lib/copy';
import {CART_COUNTRY_ACTION, CART_UPDATED_EVENT, type CartCountryReply} from '~/lib/cart-client';
import {currencyForCountry, regionSwitchCountry, type SwitchCurrency} from '~/lib/region-switch';
import {shipCountryCookie, shippingQuote} from '~/lib/shipping-rates';
import type {loader as rootLoader} from '~/root';

const CHOICES: readonly SwitchCurrency[] = ['EUR', 'USD'];

/**
 * The EUR | USD pill of the header and the mobile menu. It is a region
 * switch, not a display toggle: it posts the destination to the same route
 * action as the cart's "Ship to" select (`/api/shopify/cart-country`), which
 * sets the `od_ship_country` cookie, moves the cart to that market and
 * rewrites its ship promises; React Router then reads every active loader
 * again, so prices, cart and checkout follow together.
 *
 * The state is read from the root loader, so the server renders the right
 * side already pressed. While the shop is closed there is no cart to move and
 * the cart route refuses, so the pick is only remembered: the same cookie,
 * written with the same helper, then the loaders read again. Nothing renders while US sales are closed (the root
 * loader carries no US rate) or for a visitor from a blocked country.
 */
export function RegionSwitch({className}: {className?: string}) {
  const root = useRouteLoaderData<typeof rootLoader>('root');
  const usRate = root && 'usShippingRate' in root ? (root.usShippingRate ?? null) : null;
  const country = root?.visitorCountry ?? null;
  const shopOpen = root?.shopOpen === true;
  const fetcher = useFetcher<CartCountryReply>();
  const revalidator = useRevalidator();
  const [picked, setPicked] = useState<string | null>(null);
  const labelId = useId();
  const busy = fetcher.state !== 'idle' || revalidator.state !== 'idle';
  const failed = !busy && Boolean(fetcher.data?.error);

  // Tell the cart badge once a switch has settled.
  const reported = useRef(false);
  useEffect(() => {
    if (busy === reported.current) return;
    reported.current = busy;
    if (busy) return;
    const reply = fetcher.data;
    if (reply && !reply.error && reply.summary) {
      window.dispatchEvent(
        new CustomEvent(CART_UPDATED_EVENT, {detail: {totalQuantity: reply.summary.totalQuantity}}),
      );
    }
  }, [busy, fetcher.data]);

  if (usRate == null) return null;
  if (shippingQuote(country, undefined, usRate)?.kind === 'blocked') return null;

  // While a switch is in flight the pill already shows the target side.
  const pending = fetcher.formData?.get('country');
  const active = currencyForCountry(
    typeof pending === 'string' ? pending : revalidator.state !== 'idle' && picked ? picked : country,
    usRate,
  );
  const label = copyText('chrome.region_switch_aria') ?? 'Currency and shipping region';

  const choose = (choice: SwitchCurrency) => {
    if (busy || choice === active) return;
    const next = regionSwitchCountry(choice, country, usRate);
    if (!next) return;
    if (!shopOpen) {
      const cookie = shipCountryCookie(next, window.location.protocol === 'https:');
      if (!cookie) return;
      document.cookie = cookie;
      setPicked(next);
      void revalidator.revalidate();
      return;
    }
    void fetcher.submit({country: next}, {method: 'post', action: CART_COUNTRY_ACTION});
  };

  return (
    <div
      className={`region-switch${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      data-currency={active}
    >
      {CHOICES.map((choice) => (
        <button
          key={choice}
          type="button"
          aria-pressed={active === choice}
          data-active={active === choice ? 'true' : undefined}
          onClick={() => choose(choice)}
        >
          {choice}
        </button>
      ))}
      {failed ? (
        <span id={labelId} className="sr-only" role="alert">
          {copyText('chrome.region_switch_failed') ?? 'Could not change the region. Try again.'}
        </span>
      ) : null}
    </div>
  );
}
