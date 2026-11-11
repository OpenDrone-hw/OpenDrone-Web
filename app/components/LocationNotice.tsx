import {useEffect, useRef, useState, type KeyboardEvent} from 'react';
import {useMatches, useRouteLoaderData} from 'react-router';
import type {RootLoader} from '~/root';
import {GEO_NOTICE_COPY} from '~/lib/geo-availability';
import {cartQuoteCountry} from '~/lib/shipping-rates';
import {
  NOTICE_ANNOUNCED_KEY,
  NOTICE_LAST_SEEN_KEY,
  nextLastSeen,
  noticeFor,
  noticeText,
} from '~/lib/location-notice';

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the notice still works for this page view.
  }
};

/** The cart page's quote country (as CartPage computes it), or null off the cart or for an empty cart. */
function useCartCountry(): string | null {
  const root = useRouteLoaderData<RootLoader>('root');
  const cartMatch = useMatches().find((m) => m.id === 'routes/cart.$');
  const data = cartMatch?.data as {country?: string | null; cart?: {country?: string | null; lines?: unknown[]} | null} | undefined;
  if (!data?.cart?.lines?.length) return null;
  return cartQuoteCountry(data.country ?? data.cart.country, root?.visitorCountry ?? null, root?.usShippingRate ?? null);
}

/** True when the cart page shows its own role=alert notice (a market move,
 *  a ship date change): it already speaks the change. */
function cartAnnounces(): boolean {
  return Boolean(document.querySelector('.cart-alert[role="alert"]'));
}

/** Focus `target` if it is still in the page and focusable, else <main>
 *  (tabindex -1, not a Tab stop). */
function restoreFocus(target: HTMLElement | null): void {
  if (target?.isConnected && !target.hasAttribute('disabled')) {
    target.focus({preventScroll: true});
    if (document.activeElement === target) return;
  }
  const main = document.getElementById('main-content');
  if (!main) return;
  if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
  main.focus({preventScroll: true});
}

/**
 * A small fixed toast, bottom right (bottom on phones, above the cart's
 * checkout bar), that says the ship time for the visitor's destination when
 * it changes: a new country from the header RegionSwitch or the cart's Ship
 * to select (both revalidate the root loader), a `?country` link, or a cart
 * that quotes another country. The rules are in lib/location-notice.ts.
 *
 * The polite live region is in the DOM from the first render (empty on the
 * server and at hydration, so no mismatch); the text arrives from an effect.
 * It takes no focus and stays until dismissed (button, or Escape inside).
 * Dismissing returns focus to where it was when the notice opened (the Ship
 * to select, the region switch), else to <main>, never to <body>. When the
 * cart already announces the same change (its role=alert notice), the notice
 * shows without speaking, so the change is not announced twice.
 */
export function LocationNotice() {
  const root = useRouteLoaderData<RootLoader>('root');
  const geo = root?.geo;
  // US sales open: the US reads the March 2027 line, not "Not shipping to the US yet."
  const usOpen = root?.usShippingRate != null;
  const cartCountry = useCartCountry();
  const locale = geo?.locale ?? 'en';
  const current = geo?.country ?? null;
  const [text, setText] = useState<string | null>(null);
  // Speak the line, or only show it (the cart's own alert speaks the change).
  const [live, setLive] = useState(true);
  // Where focus was when the notice opened: dismissing returns it there.
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const lastSeen = read(NOTICE_LAST_SEEN_KEY);
    const notice = noticeFor({lastSeen, current, cartCountry, announced: read(NOTICE_ANNOUNCED_KEY)});
    const seen = nextLastSeen(lastSeen, current);
    if (seen) write(NOTICE_LAST_SEEN_KEY, seen);
    if (!notice) return;
    const line = noticeText(notice.country, locale, usOpen);
    if (!line) return;
    write(NOTICE_ANNOUNCED_KEY, notice.key);
    const active = document.activeElement;
    returnTo.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setLive(!cartAnnounces());
    setText(line);
  }, [current, cartCountry, locale, usOpen]);

  // Closing unmounts the focused button: hand focus back first, so it never
  // drops to <body>.
  const dismiss = () => {
    if (document.activeElement?.closest('.location-notice')) restoreFocus(returnTo.current);
    returnTo.current = null;
    setText(null);
  };

  // The dismiss button is the only focusable element, so "Escape while focus
  // is inside" is a key handler on it.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && text) {
      event.stopPropagation();
      dismiss();
    }
  };

  return (
    <div className="location-notice" data-open={text ? '' : undefined}>
      {/* The live region is never display:none (an inserted line would not
          be spoken); the visible line is separate, hidden from assistive tech
          while the live region carries the same words. */}
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {live ? text : null}
      </p>
      {text ? (
        <p className="location-notice-text" aria-hidden={live ? true : undefined}>
          {text}
        </p>
      ) : null}
      {text ? (
        <button
          type="button"
          className="location-notice-close"
          aria-label={GEO_NOTICE_COPY[locale].dismiss}
          onClick={dismiss}
          onKeyDown={onKeyDown}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}
