/**
 * Flat shipping rates per destination, in EUR including VAT, as set in the
 * Shopify shipping profile (bpost). Display only: Shopify checkout charges
 * the rate for the shipping address. Import duties are never collected at
 * checkout; outside the EU the buyer pays them to the carrier on delivery.
 *
 * Bundler-free (no imports) so the node:test suites can load it.
 */

/** Countries Incutec does not ship to. */
export const BLOCKED_COUNTRIES: ReadonlySet<string> = new Set(['RU', 'BY', 'IR', 'KP', 'SY', 'CU']);

const EU = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export type ShippingZone = {
  id: 'be' | 'near' | 'eu' | 'eu_far' | 'europe' | 'us' | 'world';
  /** Countries in the zone; empty for the rest of the world. */
  countries: string[];
  /** Flat rate in EUR, VAT included. */
  rate: number;
};

/** The rate table, in the order a shipping page lists it. */
export const SHIPPING_ZONES: ShippingZone[] = [
  {id: 'be', countries: ['BE'], rate: 8.5},
  {id: 'near', countries: ['DE', 'FR', 'LU', 'NL'], rate: 9.95},
  {
    id: 'eu',
    countries: [...EU].filter((c) => !['BE', 'DE', 'FR', 'LU', 'NL', 'CY', 'EE', 'MT'].includes(c)).sort(),
    rate: 12.95,
  },
  {id: 'eu_far', countries: ['CY', 'EE', 'MT'], rate: 16.95},
  {id: 'europe', countries: ['GB', 'CH', 'NO', 'IS', 'LI'], rate: 24.95},
  {id: 'us', countries: ['US'], rate: 19.95},
  {id: 'world', countries: [], rate: 39.95},
];

/** Who collects import duties for an order to this country: none inside the
 *  EU, the carrier on delivery everywhere else. */
export type DutyNote = 'none' | 'us' | 'intl';

export type ShippingQuote =
  | {country: string; blocked: true}
  | {country: string; blocked: false; zone: ShippingZone['id']; rate: number; duty: DutyNote};

/** The flat rate to one ISO country code, or null for an unknown country. */
export function shippingQuote(country: string | null): ShippingQuote | null {
  const code = country?.trim().toUpperCase();
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  if (BLOCKED_COUNTRIES.has(code)) return {country: code, blocked: true};
  const zone =
    SHIPPING_ZONES.find((z) => z.countries.includes(code)) ??
    SHIPPING_ZONES[SHIPPING_ZONES.length - 1];
  return {
    country: code,
    blocked: false,
    zone: zone.id,
    rate: zone.rate,
    duty: EU.has(code) ? 'none' : code === 'US' ? 'us' : 'intl',
  };
}

/** The English country name for a code, falling back to the code. */
export function countryName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], {type: 'region'}).of(code) ?? code;
  } catch {
    return code;
  }
}
