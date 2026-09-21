/**
 * The visitor's country, for display only: which price note the buy module
 * shows. Cloudflare sets `CF-IPCountry` on every request to the Worker; a
 * `?country=XX` query overrides it so a page can be checked as seen from
 * another country. Nothing about the order depends on it: Shopify checkout
 * decides tax, shipping and duties from the shipping address.
 *
 * Bundler-free (no imports) so the node:test suites can load it.
 */

const EU = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export function visitorCountry(request: Request): string | null {
  const override = new URL(request.url).searchParams.get('country')?.trim().toUpperCase();
  const raw = override || request.headers.get('CF-IPCountry')?.trim().toUpperCase();
  return raw && /^[A-Z]{2}$/.test(raw) && raw !== 'XX' ? raw : null;
}

/** EU consumers pay the VAT-inclusive price; unknown counts as EU, the default market. */
export function paysEuVat(country: string | null): boolean {
  return country === null || EU.has(country);
}
