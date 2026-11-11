import {useEffect, useId, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {useFetcher, useRevalidator, useRouteLoaderData} from 'react-router';
import {useHeaderPopover} from '~/components/header-popover';
import {ShipToSelect} from '~/components/ShipToSelect';
import {copyText} from '~/lib/copy';
import {CART_COUNTRY_ACTION, CART_UPDATED_EVENT, type CartCountryReply} from '~/lib/cart-client';
import {listedMarkets, marketCountry, regionFor, type MarketId, type Region} from '~/lib/region';
import {countryName, shipCountryCookie} from '~/lib/shipping-rates';
import type {loader as rootLoader} from '~/root';

type Choice = Exclude<MarketId, 'none'>;

const LABELS: Record<Choice, [string, string]> = {
  eu: ['chrome.region_switch_eu', 'EU / EUR'],
  us: ['chrome.region_switch_us', 'US / USD'],
  import: ['chrome.region_switch_import', 'UK, CH, NO / EUR'],
  world: ['chrome.region_switch_world', 'World / EUR'],
};

const NOTES: Record<Choice, [string, string]> = {
  eu: ['chrome.region_switch_eu_note', 'EU addresses. Euro, VAT included'],
  us: ['chrome.region_switch_us_note', 'United States. Dollars, duties included'],
  import: ['chrome.region_switch_import_note', 'UK, Switzerland, Norway. Euro, import VAT and duties on delivery'],
  world: ['chrome.region_switch_world_note', 'Other countries. Euro, import charges on delivery'],
};

/** What a choice reads as: the market it ships to and its currency. */
export function choiceLabel(choice: Choice): string {
  return copyText(LABELS[choice][0]) ?? LABELS[choice][1];
}

function choiceNote(choice: Choice): string {
  return copyText(NOTES[choice][0]) ?? NOTES[choice][1];
}

/**
 * The trigger text: the market, or the country itself where one market
 * holds many countries (UK / CH / NO, world) so it is never a guess, or
 * "<Country>: not shipping yet" where nothing can be bought.
 */
export function regionTriggerLabel(region: Pick<Region, 'market' | 'country' | 'currency'>): string {
  if (region.market === 'eu' || region.market === 'us') return choiceLabel(region.market);
  if (region.market === 'none') {
    return (copyText('chrome.region_switch_none') ?? '{country}: not shipping yet').replace(
      '{country}',
      region.country ?? '',
    );
  }
  return `${region.country ?? ''} / ${region.currency}`;
}

/**
 * The region control of the header (`variant="menu"`) and the mobile drawer
 * (`variant="segmented"`). It lists exactly the markets Shopify sells to
 * (`listedMarkets`: EU, US while its gate is open, UK / CH / NO, rest of
 * world) and shows the current one from the root loader's `region`, the one
 * resolver's answer, so the server renders the right one already checked.
 *
 * A choice posts the destination to `/api/shopify/cart-country` (cookie,
 * cart buyer country and ship promises move together); React Router then
 * reads every active loader again, so prices and lanes re-render in place.
 * While the shop is closed the cookie is written directly, then the loaders
 * read again. "Another country" (the cart's Ship to list) picks any single
 * country. A failed switch says so visibly. Nothing renders for a visitor
 * from a blocked country.
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
  const region = root?.region ?? null;
  const ipCountry = root?.ipCountry ?? null;
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

  if (!region) return null;
  if (region.shipping.available === false && region.shipping.reason === 'blocked') return null;
  const usOpen = usRate != null;
  const choices = listedMarkets(usOpen);

  // While a switch is in flight the control already shows the target.
  const pending = fetcher.formData?.get('country');
  const target = typeof pending === 'string' ? pending : revalidator.state !== 'idle' && picked ? picked : null;
  const shown = target ? regionFor(target, 'choice', usOpen) : region;
  const active: Choice | null = shown.market === 'none' ? null : shown.market;
  const activeLabel = regionTriggerLabel(shown);
  const label = copyText('chrome.region_switch_aria') ?? 'Ship to and currency';

  const choose = (choice: Choice) => {
    if (busy || choice === active) return;
    const next = marketCountry(choice, region, ipCountry, usOpen);
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
  // A choice that has no country to switch to (rest of world with no known
  // rest-of-world country) is offered through the country list instead.
  const selectable = (choice: Choice) => marketCountry(choice, region, ipCountry, usOpen) != null;
  const other = shopOpen ? (
    <ShipToSelect
      country={region.country}
      usRate={usRate}
      className="ship-to region-other"
    />
  ) : null;

  if (variant === 'menu') {
    return (
      <RegionMenu
        className={className}
        label={label}
        choices={choices}
        selectable={selectable}
        active={active}
        activeLabel={activeLabel}
        busy={busy}
        failed={failed}
        failedId={labelId}
        onChoose={choose}
        other={other}
      />
    );
  }

  return (
    <div
      className={`region-switch${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
      aria-busy={busy || undefined}
      data-market={shown.market}
    >
      {choices.map((choice) => (
        <button
          key={choice}
          type="button"
          title={choiceNote(choice)}
          aria-pressed={active === choice}
          data-active={active === choice ? 'true' : undefined}
          disabled={!selectable(choice) && active !== choice}
          onClick={() => choose(choice)}
        >
          {choiceLabel(choice)}
        </button>
      ))}
      {active == null ? <span className="region-switch-caption">{activeLabel}</span> : null}
      {other}
      {failed ? <RegionFailed id={labelId} /> : null}
    </div>
  );
}

function RegionFailed({id}: {id: string}) {
  return (
    <span id={id} className="region-switch-failed" role="alert">
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
  choices,
  selectable,
  active,
  activeLabel,
  busy,
  failed,
  failedId,
  onChoose,
  other,
}: {
  className?: string;
  label: string;
  choices: Choice[];
  selectable: (choice: Choice) => boolean;
  active: Choice | null;
  activeLabel: string;
  busy: boolean;
  failed: boolean;
  failedId: string;
  onChoose: (choice: Choice) => void;
  other: React.ReactNode;
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
      data-market={active ?? 'none'}
      data-open={open ? 'true' : undefined}
    >
      <button
        ref={triggerRef}
        type="button"
        className="header-popover-trigger"
        aria-label={`${label}: ${activeLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={onTriggerKey}
      >
        {activeLabel}
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
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              role="menuitemradio"
              aria-checked={active === choice}
              aria-disabled={!selectable(choice) && active !== choice ? true : undefined}
              className="header-popover-item"
              onClick={() => {
                if (!selectable(choice) && active !== choice) return;
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
          {other ? <div role="none" className="region-menu-other">{other}</div> : null}
        </div>
      ) : null}
      {failed ? <RegionFailed id={failedId} /> : null}
    </div>
  );
}
