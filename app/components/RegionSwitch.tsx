import {useEffect, useId, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {useFetcher, useRevalidator, useRouteLoaderData} from 'react-router';
import {useHeaderPopover} from '~/components/header-popover';
import {copyText} from '~/lib/copy';
import {CART_COUNTRY_ACTION, CART_UPDATED_EVENT, type CartCountryReply} from '~/lib/cart-client';
import {currencyForCountry, regionSwitchCountry, type SwitchCurrency} from '~/lib/region-switch';
import {shipCountryCookie, shippingQuote} from '~/lib/shipping-rates';
import type {loader as rootLoader} from '~/root';

const CHOICES: readonly SwitchCurrency[] = ['EUR', 'USD'];

/** What a choice reads as: the region it ships to and its currency. */
function choiceLabel(choice: SwitchCurrency): string {
  return choice === 'USD'
    ? (copyText('chrome.region_switch_us') ?? 'US · USD')
    : (copyText('chrome.region_switch_eu') ?? 'EU · EUR');
}

function choiceNote(choice: SwitchCurrency): string {
  return choice === 'USD'
    ? (copyText('chrome.region_switch_us_note') ?? 'Ships to the United States, prices in dollars')
    : (copyText('chrome.region_switch_eu_note') ?? 'Ships to the EU, prices in euro');
}

/**
 * The region switch of the header and the mobile menu: a compact "EU · EUR" menu
 * button in the header (`variant="menu"`), the full "EU · EUR | US · USD" segmented pill
 * in the drawer (default). It is a region
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
export function RegionSwitch({
  className,
  variant = 'segmented',
}: {
  className?: string;
  variant?: 'segmented' | 'menu';
}) {
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
  const label = copyText('chrome.region_switch_aria') ?? 'Ship to and currency';

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

  if (variant === 'menu') {
    return (
      <RegionMenu
        className={className}
        label={label}
        active={active}
        busy={busy}
        failed={failed}
        failedId={labelId}
        onChoose={choose}
      />
    );
  }

  return (
    <div
      className={`region-switch${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      data-currency={active}
    >
      <span className="region-switch-caption" aria-hidden="true">
        {copyText('chrome.region_switch_caption') ?? 'Ship to'}
      </span>
      {CHOICES.map((choice) => (
        <button
          key={choice}
          type="button"
          title={choiceNote(choice)}
          aria-pressed={active === choice}
          data-active={active === choice ? 'true' : undefined}
          onClick={() => choose(choice)}
        >
          {choiceLabel(choice)}
        </button>
      ))}
      {failed ? <RegionFailed id={labelId} /> : null}
    </div>
  );
}

function RegionFailed({id}: {id: string}) {
  return (
    <span id={id} className="sr-only" role="alert">
      {copyText('chrome.region_switch_failed') ?? 'Could not change the region. Try again.'}
    </span>
  );
}

/**
 * The header's low-emphasis form: an outlined "EUR" button that opens a small
 * menu of the two choices (menuitemradio, the active one checked). Same
 * `choose` as the segmented pill, so it posts to the same route action.
 * Keyboard: Enter, Space or ArrowDown opens onto the active item; arrows, Home
 * and End move; Enter or Space picks; Escape closes and returns focus.
 */
function RegionMenu({
  className,
  label,
  active,
  busy,
  failed,
  failedId,
  onChoose,
}: {
  className?: string;
  label: string;
  active: SwitchCurrency;
  busy: boolean;
  failed: boolean;
  failedId: string;
  onChoose: (choice: SwitchCurrency) => void;
}) {
  const {open, setOpen, close, rootRef, triggerRef, onBlur} = useHeaderPopover();
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);

  // Focus the active item when the menu opens.
  useEffect(() => {
    if (!open) return;
    const list = items();
    (list.find((el) => el.getAttribute('aria-checked') === 'true') ?? list[0])?.focus();
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % list.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Tab') {
      close();
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    list[next]?.focus();
  };

  return (
    <div
      ref={rootRef}
      onBlur={onBlur}
      className={`header-popover region-menu${className ? ` ${className}` : ''}`}
      aria-busy={busy || undefined}
      data-currency={active}
      data-open={open ? 'true' : undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="header-popover-trigger"
        aria-label={`${label}: ${choiceLabel(active)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKey}
      >
        {choiceLabel(active)}
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {open ? (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-label={label}
          className="header-popover-panel"
          onKeyDown={onMenuKey}
        >
          {CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={active === choice}
              className="header-popover-item"
              onClick={() => {
                onChoose(choice);
                close(true);
              }}
            >
              <span className="region-menu-choice">
                <span>{choiceLabel(choice)}</span>
                <small>{choiceNote(choice)}</small>
              </span>
              {active === choice ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {failed ? <RegionFailed id={failedId} /> : null}
    </div>
  );
}
