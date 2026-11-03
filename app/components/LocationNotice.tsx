import {useEffect, useState, type KeyboardEvent} from 'react';
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
 */
export function LocationNotice() {
  const geo = useRouteLoaderData<RootLoader>('root')?.geo;
  const cartCountry = useCartCountry();
  const locale = geo?.locale ?? 'en';
  const current = geo?.country ?? null;
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const lastSeen = read(NOTICE_LAST_SEEN_KEY);
    const notice = noticeFor({lastSeen, current, cartCountry, announced: read(NOTICE_ANNOUNCED_KEY)});
    const seen = nextLastSeen(lastSeen, current);
    if (seen) write(NOTICE_LAST_SEEN_KEY, seen);
    if (!notice) return;
    const line = noticeText(notice.country, locale);
    if (!line) return;
    write(NOTICE_ANNOUNCED_KEY, notice.key);
    setText(line);
  }, [current, cartCountry, locale]);

  // The dismiss button is the only focusable element, so "Escape while focus
  // is inside" is a key handler on it.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && text) {
      event.stopPropagation();
      setText(null);
    }
  };

  return (
    <div className="location-notice" data-open={text ? '' : undefined}>
      <p className="location-notice-text" role="status" aria-live="polite" aria-atomic="true">
        {text}
      </p>
      {text ? (
        <button
          type="button"
          className="location-notice-close"
          aria-label={GEO_NOTICE_COPY[locale].dismiss}
          onClick={() => setText(null)}
          onKeyDown={onKeyDown}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}
