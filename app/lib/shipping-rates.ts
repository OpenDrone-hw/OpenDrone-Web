/**
 * Flat shipping rates per destination, in EUR including VAT, as set in the
 * Shopify shipping profile (bpost). Display only: Shopify checkout charges
 * the rate for the shipping address. Consumers buy direct only inside the
 * EU, where no import duty or customs clearance is due; every other country
 * that is not blocked buys through shops.
 *
 * Bundler-free (no imports) so the node:test suites can load it.
 */

/** Countries Incutec does not ship to. */
export const BLOCKED_COUNTRIES: ReadonlySet<string> = new Set(['RU', 'BY', 'IR', 'KP', 'SY', 'CU']);

/** The 27 EU member states: the only destinations sold direct. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export type ShippingZone = {
  id: 'be' | 'near' | 'eu' | 'eu_far' | 'eu_bg';
  /** Countries in the zone. Together the zones hold the EU27, once each. */
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
    countries: [...EU_COUNTRIES].filter((c) => !['BE', 'DE', 'FR', 'LU', 'NL', 'CY', 'EE', 'MT', 'BG'].includes(c)).sort(),
    rate: 12.95,
  },
  {id: 'eu_far', countries: ['CY', 'EE', 'MT'], rate: 16.95},
  // The rate mirrors the Shopify profile, which bills Bulgaria at its world rate.
  {id: 'eu_bg', countries: ['BG'], rate: 39.95},
];

/**
 * What a destination gets: `direct`, a consumer order at the zone's flat
 * rate (EU only); `shops`, not sold direct, available through shops;
 * `blocked`, not sold at all (`BLOCKED_COUNTRIES`).
 */
export type ShippingQuote =
  | {country: string; kind: 'blocked'}
  | {country: string; kind: 'shops'}
  | {country: string; kind: 'direct'; zone: ShippingZone['id']; rate: number};

/** The quote for one ISO country code, or null for an unknown country. */
export function shippingQuote(country: string | null): ShippingQuote | null {
  const code = isoCode(country);
  if (!code) return null;
  if (BLOCKED_COUNTRIES.has(code)) return {country: code, kind: 'blocked'};
  const zone = SHIPPING_ZONES.find((z) => z.countries.includes(code));
  if (!zone) return {country: code, kind: 'shops'};
  return {country: code, kind: 'direct', zone: zone.id, rate: zone.rate};
}

/** True for a known country outside the EU that is not blocked: it buys
 *  through shops. False for the EU, a blocked country and an unknown one
 *  (which the shop treats as its default EU market). */
export function soldThroughShops(country: string | null): boolean {
  return shippingQuote(country)?.kind === 'shops';
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

/** Territories with no postal addresses to ship to: Antarctica, Bouvet
 *  Island, Heard and McDonald Islands, South Georgia, the French Southern
 *  Territories, the US Minor Outlying Islands and the British Indian Ocean
 *  Territory. Left out of the picker; `shippingQuote` still prices them. */
export const UNINHABITED_TERRITORIES: ReadonlySet<string> = new Set([
  'AQ', 'BV', 'HM', 'GS', 'TF', 'UM', 'IO',
]);

/** Every country the destination picker lists: all of ISO 3166-1 minus
 *  `BLOCKED_COUNTRIES` and `UNINHABITED_TERRITORIES`. The EU ones are sold
 *  direct, the others through shops. */
export const SHIP_COUNTRY_CODES: readonly string[] = ISO_COUNTRIES.filter(
  (code) => !BLOCKED_COUNTRIES.has(code) && !UNINHABITED_TERRITORIES.has(code),
);

/** The destinations most orders go to, listed first in the picker, in
 *  this order, above a divider. */
export const LIKELY_SHIP_COUNTRIES: readonly string[] = ['BE', 'NL', 'DE', 'FR', 'LU'];

const optionsByLocale = new Map<string, Array<{code: string; name: string}>>();

/** The destination picker's options: every listed country, by
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

/** One picker option: `rate` is the flat rate for a country sold direct,
 *  null for one that buys through shops. */
export type ShipCountryOption = {code: string; name: string; rate: number | null};

/**
 * The destination picker in two groups: `likely` (Belgium, the
 * Netherlands, Germany, France, Luxembourg, in that order) goes first,
 * then a divider, then `rest`, every other listed country by name.
 * Each option carries its flat rate, or null where it buys through shops.
 */
export function shipCountryPicker(locale = 'en'): {likely: ShipCountryOption[]; rest: ShipCountryOption[]} {
  const withRate = ({code, name}: {code: string; name: string}): ShipCountryOption => {
    const q = shippingQuote(code);
    return {code, name, rate: q?.kind === 'direct' ? q.rate : null};
  };
  const all = shipCountryOptions(locale);
  return {
    likely: LIKELY_SHIP_COUNTRIES.map((code) => withRate({code, name: countryName(code, locale)})),
    rest: all.filter((o) => !LIKELY_SHIP_COUNTRIES.includes(o.code)).map(withRate),
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

/** Cookie that holds the destination a buyer picked, shared by the product
 *  page, the added-to-cart dialog and the cart, and read by the server so the
 *  first render already quotes that country. Display only, like the rates:
 *  checkout charges the rate for the address the buyer enters there. */
export const SHIP_COUNTRY_COOKIE = 'od_ship_country';

const ISO_SET: ReadonlySet<string> = new Set(ISO_COUNTRIES);

/** An ISO 3166-1 alpha-2 code, upper-cased, or null. */
function isoCode(value: string | null | undefined): string | null {
  const code = value?.trim().toUpperCase();
  return code && ISO_SET.has(code) ? code : null;
}

/** The `document.cookie` / `Set-Cookie` string that keeps a picked
 *  destination for a year on the whole site. Null for a code the picker does
 *  not list, so a blocked or bogus pick is never kept. */
export function shipCountryCookie(country: string, secure = true): string | null {
  const code = isoCode(country);
  if (!code || !SHIP_COUNTRY_CODES.includes(code)) return null;
  return `${SHIP_COUNTRY_COOKIE}=${code}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/** The picked destination from a `Cookie` header (or `document.cookie`). */
export function shipCountryFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SHIP_COUNTRY_COOKIE) continue;
    const code = isoCode(part.slice(eq + 1));
    return code && SHIP_COUNTRY_CODES.includes(code) ? code : null;
  }
  return null;
}

/** The first region subtag in an `Accept-Language` header, by preference
 *  weight: `de-DE,de;q=0.9` gives DE, `en-US` gives US. A bare language
 *  (`de`, `fr`, `en`) names no country and is skipped. */
export function countryFromAcceptLanguage(header: string | null | undefined): string | null {
  if (!header) return null;
  const tags = header
    .split(',')
    .map((entry, index) => {
      const [tag, ...params] = entry.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return {tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, index};
    })
    .filter((t) => t.tag && t.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const {tag} of tags) {
    // The region is the first two-letter subtag after the language
    // (`zh-Hant-TW` gives TW; a numeric region like `es-419` is skipped).
    const region = tag.split('-').slice(1).find((sub) => /^[A-Za-z]{2}$/.test(sub));
    const code = isoCode(region);
    if (code) return code;
  }
  return null;
}

/**
 * The destination the shop quotes by default for this request, in order:
 * a `?country=XX` query (to check a page as seen from another country), the
 * buyer's own pick in the `od_ship_country` cookie, Cloudflare's
 * `CF-IPCountry`, then the region in `Accept-Language`. Null when none of
 * them names a country. A blocked or shops-only country from the IP or the
 * browser is returned as is, so the page can say so.
 */
export function shipCountryForRequest(request: Request): string | null {
  const override = isoCode(new URL(request.url).searchParams.get('country'));
  if (override) return override;
  const picked = shipCountryFromCookie(request.headers.get('Cookie'));
  if (picked) return picked;
  const ip = isoCode(request.headers.get('CF-IPCountry'));
  if (ip) return ip;
  return countryFromAcceptLanguage(request.headers.get('Accept-Language'));
}
