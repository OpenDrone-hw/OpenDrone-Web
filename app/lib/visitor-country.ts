/**
 * The visitor's country, for display only: which price note the buy module
 * shows. Cloudflare sets `CF-IPCountry` on every request to the Worker; a
 * `?country=XX` query overrides it so a page can be checked as seen from
 * another country. Nothing about the order depends on it: Shopify checkout
 * decides tax and shipping from the shipping address. While US sales are
 * open the root loader uses `shipCountryForRequest` instead, the same
 * destination the cart and checkout read.
 *
 * Bundler-free (one relative import) so the node:test suites can load it.
 */

import {EU_COUNTRY_CODES} from './eu-countries.ts';
import {isInternationalQuote, shippingQuote} from './shipping-rates.ts';

const EU: ReadonlySet<string> = new Set(EU_COUNTRY_CODES);

export function visitorCountry(request: Request): string | null {
  const override = new URL(request.url).searchParams.get('country')?.trim().toUpperCase();
  const raw = override || request.headers.get('CF-IPCountry')?.trim().toUpperCase();
  return raw && /^[A-Z]{2}$/.test(raw) && raw !== 'XX' ? raw : null;
}

/** EU consumers pay the VAT-inclusive price; unknown counts as EU, the default market. */
export function paysEuVat(country: string | null): boolean {
  return country === null || EU.has(country);
}

/** Which price note a visitor sees: EU VAT included, the US note (no
 *  sales tax, duties included) while US sales are open, or the international checkout note for other permitted destinations. */
export type PriceNote = 'vat' | 'us' | 'international' | 'shops';

export function priceNote(country: string | null, usOpen = false): PriceNote {
  if (paysEuVat(country)) return 'vat';
  if (usOpen && country === 'US') return 'us';
  return isInternationalQuote(shippingQuote(country)) ? 'international' : 'shops';
}
