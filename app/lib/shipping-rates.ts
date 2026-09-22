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
  /** Countries in the zone; empty for the rest of the world, which
   *  includes Bulgaria (an EU country billed at the world rate). */
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
    countries: [...EU].filter((c) => !['BE', 'DE', 'FR', 'LU', 'NL', 'CY', 'EE', 'MT', 'BG'].includes(c)).sort(),
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

/** Every ISO 3166-1 country code. */
const ISO_COUNTRIES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP ' +
  'KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT ' +
  'MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW ' +
  'SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG ' +
  'UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

/** Every country code Incutec ships to: all of ISO 3166-1 minus
 *  `BLOCKED_COUNTRIES`, for a destination picker. */
export const SHIP_COUNTRY_CODES: readonly string[] = ISO_COUNTRIES.filter(
  (code) => !BLOCKED_COUNTRIES.has(code),
);

const optionsByLocale = new Map<string, Array<{code: string; name: string}>>();

/** The destination picker's options: every country Incutec ships to, by
 *  name. The blocked countries are left out, from the same set
 *  `shippingQuote` refuses. Built once per locale. */
export function shipCountryOptions(locale = 'en'): Array<{code: string; name: string}> {
  let options = optionsByLocale.get(locale);
  if (!options) {
    options = SHIP_COUNTRY_CODES.map((code) => ({code, name: countryName(code, locale)})).sort((a, b) =>
      a.name.localeCompare(b.name, locale),
    );
    optionsByLocale.set(locale, options);
  }
  return options;
}

/** The English country name for a code, falling back to the code. */
export function countryName(code: string, locale = 'en'): string {
  try {
    return new Intl.DisplayNames([locale], {type: 'region'}).of(code) ?? code;
  } catch {
    return code;
  }
}
