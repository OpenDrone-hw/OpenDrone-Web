import {useEffect, useId, useMemo, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {Link, useRevalidator, useRouteLoaderData} from 'react-router';
import {useAside} from '~/components/Aside';
import {useHeaderPopover} from '~/components/header-popover';
import {copyText} from '~/lib/copy';
import {CART_COUNTRY_ACTION, CART_UPDATED_EVENT, type CartCountryReply} from '~/lib/cart-client';
import {
  MARKETS_PATH,
  OPEN_COUNTRY_PICKER_EVENT,
  chooseCountry,
  filterGroups,
  flatOptions,
  pickerGroups,
  pickerLabel,
} from '~/lib/country-picker';
import {setPendingShipTo, usePendingShipTo} from '~/lib/pending-ship-to';
import {regionFor} from '~/lib/region';
import {countryName, shipCountryCookie} from '~/lib/shipping-rates';
import type {RootLoader} from '~/root';

const t = (id: string, fallback: string) => copyText(id) ?? fallback;

/**
 * The one country picker: the header pill ("BE · EUR"), the phone drawer,
 * the cart's and the added-to-cart dialog's "Ship to". Opening it shows one
 * searchable country list, the current country ticked, and one link to
 * /markets. Nothing else: the markets, taxes and shipping are explained on
 * /markets.
 *
 * A choice posts the country to `/api/shopify/cart-country` (cookie, cart
 * buyer country and ship promises move together; the server's resolver
 * maps the country to its market), then every loader reads again. While it
 * is in flight every picker, the bar and the cart already show the new
 * country (`pending-ship-to`), so the header and the cart never disagree.
 * While the shop is closed the cookie is written directly, then the loaders
 * read again. Nothing renders for a visitor from a blocked country (no
 * switch moves them).
 */
export function CountryPicker({
  variant = 'header',
  country: shownCountry,
  onChanged,
  onBusy,
  className,
}: {
  /** `header`: the pill. `field`: a labelled "Ship to" row (cart, dialog, phone drawer). */
  variant?: 'header' | 'field';
  /** The destination the page quotes; defaults to the root region's country. */
  country?: string | null;
  /** The reply of a successful switch, before the page reads again. */
  onChanged?: (reply: CartCountryReply) => void;
  onBusy?: (busy: boolean) => void;
  className?: string;
}) {
  const root = useRouteLoaderData<RootLoader>('root');
  const region = root?.region ?? null;
  const usRate = root && 'usShippingRate' in root ? ((root.usShippingRate as number | undefined) ?? null) : null;
  const usOpen = usRate != null;
  const shopOpen = root?.shopOpen === true;
  const revalidator = useRevalidator();
  const pendingCountry = usePendingShipTo();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const {open, setOpen, close, rootRef, triggerRef, onBlur} = useHeaderPopover();
  const ids = useId();
  const listId = `${ids}-list`;
  const failedId = `${ids}-failed`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const confirmed = shownCountry !== undefined ? shownCountry : (region?.country ?? null);
  const current = pendingCountry ?? confirmed;
  const shown = current ? regionFor(current, 'choice', usOpen) : region;
  const groups = useMemo(
    () =>
      pickerGroups(usRate, {
        pinned: t('cart.ship_to_group_main', 'Most orders'),
        eu: t('cart.ship_to_group_eu', 'European Union'),
        world: t('cart.ship_to_group_world', 'Other countries'),
      }),
    [usRate],
  );
  const matches = useMemo(() => filterGroups(groups, query), [groups, query]);
  const options = useMemo(() => flatOptions(matches), [matches]);

  // A "choose your country" link elsewhere on the page opens the picker
  // that is on screen (the header pill on a laptop, the drawer's on a phone).
  useEffect(() => {
    const onOpen = () => {
      if (rootRef.current?.offsetParent == null) return;
      setOpen(true);
    };
    window.addEventListener(OPEN_COUNTRY_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COUNTRY_PICKER_EVENT, onOpen);
  }, [rootRef, setOpen]);

  // Opening: a fresh search, the current country active and in view.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const at = flatOptions(groups).findIndex((o) => o.code === current);
    setActive(Math.max(0, at));
    inputRef.current?.focus({preventScroll: true});
    requestAnimationFrame(() => {
      listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'center'});
    });
    // Only on open: typing must not jump back to the current country.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!region) return null;
  if (region.shipping.available === false && region.shipping.reason === 'blocked') return null;

  const choose = async (next: string) => {
    const choice = chooseCountry(current, next, usOpen);
    close(true);
    if (!choice || busy) return;
    setFailed(false);
    if (!shopOpen) {
      const cookie = shipCountryCookie(choice.country, window.location.protocol === 'https:');
      if (!cookie) return;
      document.cookie = cookie;
      setPendingShipTo(choice.country, root);
      void revalidator.revalidate();
      return;
    }
    // The bar, ship lines, the cart and every other picker follow at once;
    // cleared when the root loader returns new data (PageLayout), on
    // failure, or after a timeout (lib/pending-ship-to.ts).
    setPendingShipTo(choice.country, root);
    setBusy(true);
    onBusy?.(true);
    try {
      // A plain POST, not a router fetcher: any failure (an error reply, a
      // proxy error page, a dropped connection) stays a message here.
      const response = await fetch(CART_COUNTRY_ACTION, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({country: choice.country}),
        credentials: 'same-origin',
      });
      const reply = (await response.json().catch(() => null)) as CartCountryReply | null;
      if (!response.ok || !reply || reply.error) throw new Error('ship-to switch failed');
      if (reply.summary) {
        window.dispatchEvent(new CustomEvent(CART_UPDATED_EVENT, {detail: {totalQuantity: reply.summary.totalQuantity}}));
      }
      onChanged?.(reply);
      await revalidator.revalidate();
    } catch {
      setPendingShipTo(null);
      setFailed(true);
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      setActive(next);
      listRef.current?.querySelector(`#${CSS.escape(`${ids}-o-${options[next].code}`)}`)?.scrollIntoView({block: 'nearest'});
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const option = options[active];
      if (option) void choose(option.code);
    } else if (e.key === 'Tab') {
      close();
    }
  };

  const label = t('chrome.country_picker_label', 'Ship to');
  const pill = shown ? pickerLabel(shown) : 'Country';
  const fieldText = current ? `${countryName(current)} · ${shown?.currency ?? 'EUR'}` : t('cart.ship_to_pick', 'Choose a country');
  const activeId = options[active] ? `${ids}-o-${options[active].code}` : undefined;
  let index = -1;

  return (
    <div
      ref={rootRef}
      onBlur={onBlur}
      className={`header-popover country-picker country-picker--${variant}${className ? ` ${className}` : ''}`}
      aria-busy={busy || undefined}
      data-country={current ?? ''}
      data-open={open ? 'true' : undefined}
    >
      {variant === 'field' ? <span className="ship-to-label" aria-hidden="true">{label}</span> : null}
      <button
        ref={triggerRef}
        type="button"
        className={variant === 'header' ? 'header-popover-trigger country-picker-trigger' : 'country-picker-field'}
        aria-label={`${label}: ${current ? countryName(current) : t('cart.ship_to_pick', 'Choose a country')}, ${shown?.currency ?? 'EUR'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${ids}-panel` : undefined}
        aria-describedby={failed ? failedId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="country-picker-value">{variant === 'header' ? pill : fieldText}</span>
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {open ? (
        <div id={`${ids}-panel`} role="dialog" aria-label={label} className="header-popover-panel country-picker-panel">
          <input
            ref={inputRef}
            type="search"
            className="country-picker-search"
            role="combobox"
            aria-label={t('chrome.country_picker_search', 'Search country')}
            placeholder={t('chrome.country_picker_search', 'Search country')}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          <ul ref={listRef} id={listId} role="listbox" aria-label={label} className="country-picker-list">
            {matches.map((group) => (
              <li key={group.id} role="presentation">
                <span className="country-picker-group" aria-hidden="true">{group.label}</span>
                <ul role="group" aria-label={group.label}>
                  {group.options.map((option) => {
                    index += 1;
                    const at = index;
                    const selected = option.code === current;
                    return (
                      <li
                        key={option.code}
                        id={`${ids}-o-${option.code}`}
                        role="option"
                        aria-selected={selected}
                        data-active={at === active ? 'true' : undefined}
                        className="country-picker-option"
                        onPointerMove={() => setActive(at)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void choose(option.code)}
                        // Keys go through the search field (aria-activedescendant); this keeps an option chosen with Enter if it ever holds focus.
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void choose(option.code);
                        }}
                      >
                        <span>{option.name}</span>
                        {selected ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
                            <path d="m5 12.5 4.5 4.5L19 7.5" />
                          </svg>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
            {!options.length ? (
              <li role="presentation" className="country-picker-empty">{t('chrome.country_picker_none', 'No country matches')}</li>
            ) : null}
          </ul>
          <Link prefetch="intent" to={MARKETS_PATH} className="country-picker-help" onClick={() => close()}>
            {t('chrome.country_picker_help', 'How prices and shipping work')}
          </Link>
        </div>
      ) : null}
      {failed ? (
        <small id={failedId} className="country-picker-failed cart-line-error" role="alert">
          {t('cart.ship_to_failed', 'Could not change the country. Try again.')}
        </small>
      ) : null}
    </div>
  );
}

/**
 * A visitor with no known country (no IP country, VPN) can only pre-order:
 * batch 1 stock is sold to EU addresses. One quiet line under the buy box
 * opens the picker that is on screen: the header pill on a laptop, the
 * drawer's picker on a phone (the drawer opens first).
 */
export function ChooseCountryLine() {
  const {open} = useAside();
  const onClick = () => {
    const pill = document.querySelector<HTMLElement>('.site-header .country-picker-trigger');
    if (pill && pill.offsetParent != null) {
      window.dispatchEvent(new Event(OPEN_COUNTRY_PICKER_EVENT));
      return;
    }
    open('mobile');
    // The drawer mounts its picker; open it once it is on screen.
    window.setTimeout(() => window.dispatchEvent(new Event(OPEN_COUNTRY_PICKER_EVENT)), 350);
  };
  return (
    <p className="product-buy-ship choose-country-line" data-choose-country>
      {t('product-chrome.choose_country_lead', 'In the EU?')}{' '}
      <button type="button" className="product-buy-terms-link choose-country-link" onClick={onClick}>
        {t('product-chrome.choose_country_link', 'Choose your country to buy in stock')}
      </button>
    </p>
  );
}
