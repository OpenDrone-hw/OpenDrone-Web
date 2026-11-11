/**
 * The visitor's country and the price note it reads. The country is the one
 * resolver's answer (`resolveCountry` in shipping-rates.ts: blocked IP, link,
 * choice cookie, CF-IPCountry), the same destination the cart and checkout
 * read. Shopify checkout still decides tax and shipping from the shipping
 * address.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import {EU_COUNTRY_CODES} from './eu-countries.ts';
import {isInternationalQuote, shipCountryForRequest, shippingQuote} from './shipping-rates.ts';

const EU: ReadonlySet<string> = new Set(EU_COUNTRY_CODES);

export function visitorCountry(request: Request): string | null {
  return shipCountryForRequest(request);
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
