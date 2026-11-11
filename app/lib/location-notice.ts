/**
 * When the location notice (components/LocationNotice.tsx) shows, and what
 * it says: "Shipping to Belgium: In stock in Belgium, ships in a few working days."
 *
 * It shows once per change of the country the visitor orders to (root
 * loader `geo.country`: `?country`, the picked destination, else
 * CF-IPCountry), and on the cart page when the cart quotes another country
 * than that. Never on a first visit (nothing stored yet: the country is only
 * recorded), never twice for the same change (the announced key is stored),
 * never without a line (`geoFullLine` null).
 *
 * Bundler-free (no `~/` imports) so the node:test suites can load it.
 */

import type {Locale} from './i18n.ts';
import {GEO_NOTICE_COPY, geoAvailabilityRegion, geoFullLine} from './geo-availability.ts';
import {countryName} from './shipping-rates.ts';

/** localStorage keys: the last country seen in this browser, the last change announced. */
export const NOTICE_LAST_SEEN_KEY = 'od-location-last-v1';
export const NOTICE_ANNOUNCED_KEY = 'od-location-announced-v1';

export type NoticeInput = {
  /** The country stored on an earlier page view, or null on a first visit. */
  lastSeen: string | null | undefined;
  /** The root loader's `geo.country`. */
  current: string | null | undefined;
  /** On the cart page: the country the cart quotes, else null. */
  cartCountry?: string | null | undefined;
  /** The key of the last change announced in this browser. */
  announced: string | null | undefined;
};

export type Notice = {country: string; key: string};

const code = (c: string | null | undefined): string | null => (c && /^[A-Za-z]{2}$/.test(c) ? c.toUpperCase() : null);

/** The notice to show for this page view, or null. */
export function noticeFor({lastSeen, current, cartCountry, announced}: NoticeInput): Notice | null {
  const last = code(lastSeen);
  const now = code(current);
  const cart = code(cartCountry);
  // First visit: only record the country.
  if (!last) return null;
  let notice: Notice | null = null;
  if (cart && cart !== now) notice = {country: cart, key: `cart:${now ?? '-'}>${cart}`};
  else if (now && now !== last) notice = {country: now, key: `geo:${last}>${now}`};
  if (!notice || notice.key === announced) return null;
  return noticeText(notice.country, 'en') ? notice : null;
}

/** The country to store as last seen: the current one, else keep the stored one. */
export function nextLastSeen(lastSeen: string | null | undefined, current: string | null | undefined): string | null {
  return code(current) ?? code(lastSeen);
}

/** "Shipping to {Country}: {line}" in the locale, or null when the country has no line. */
export function noticeText(country: string, locale: Locale, usOpen = false): string | null {
  const line = geoFullLine(geoAvailabilityRegion(country, usOpen), locale);
  if (!line) return null;
  return GEO_NOTICE_COPY[locale].line.replace('{country}', countryName(country.toUpperCase(), locale)).replace('{line}', line);
}
