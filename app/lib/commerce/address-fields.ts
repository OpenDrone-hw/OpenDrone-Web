/**
 * Checkout delivery fields: which country is preselected, in which order the fields come and which HTML
 * autocomplete token each carries (WHATWG autofill, section "shipping" so browsers and password managers keep
 * the delivery address apart from any billing one). Pure, so the node tests cover it.
 */

/** The visitor's country when the app ships there, else the first country the app ships to, else the fallback. */
export function pickCountry(wanted: string | null | undefined, ship: readonly string[] | null | undefined, fallback = 'BE'): string {
  const want = (wanted ?? '').toUpperCase();
  const list = (ship ?? []).map((c) => c.toUpperCase());
  if (!list.length) return /^[A-Z]{2}$/.test(want) ? want : fallback;
  return list.includes(want) ? want : list[0];
}

/** Cloudflare's country of the request (request.cf.country), else its header; 'XX' and 'T1' (unknown, Tor) mean none. */
export function requestCountry(request: Request): string | null {
  const cf = (request as Request & {cf?: {country?: string}}).cf?.country ?? request.headers.get('CF-IPCountry');
  const code = (cf ?? '').toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'XX' && code !== 'T1' ? code : null;
}

const CITY_FIRST = new Set(['GB', 'IE', 'US', 'CA', 'AU', 'NZ', 'IN']);
/** Postal code before the city (BE, NL, DE, FR and most of Europe) or after it (the English-speaking countries). */
export function postcodeFirst(country: string): boolean {
  return !CITY_FIRST.has(country.toUpperCase());
}

const NUMBER_FIRST = new Set(['FR', 'GB', 'IE', 'US', 'CA', 'AU', 'NZ', 'LU', 'ES', 'PT', 'IT']);
/** "12 Rue de la Loi" in France and the English-speaking countries, "Wetstraat 16" in BE, NL and DE. */
export function formatLine1(street: string, number: string, country: string): string {
  if (!number) return street;
  return NUMBER_FIRST.has(country.toUpperCase()) && country.toUpperCase() !== 'LU' ? `${number} ${street}` : `${street} ${number}`;
}

export const AUTOCOMPLETE = {
  name: 'shipping name',
  line1: 'shipping address-line1',
  line2: 'shipping address-line2',
  postal_code: 'shipping postal-code',
  city: 'shipping address-level2',
  country: 'shipping country',
  phone: 'shipping tel',
} as const;

/** Postcodes the static files in public/postcodes cover, as the digits a visitor types. */
const POSTCODE_SHAPE: Record<string, RegExp> = {BE: /^\d{4}$/, NL: /^\d{4}/, DE: /^\d{5}$/, FR: /^\d{5}$/, LU: /^\d{4}$/};
export const POSTCODE_COUNTRIES = Object.keys(POSTCODE_SHAPE);
export function postcodeKey(country: string, raw: string): string | null {
  const cc = country.toUpperCase();
  const text = raw.replace(/\s+/g, '');
  const shape = POSTCODE_SHAPE[cc];
  if (!shape || !shape.test(text)) return null;
  return cc === 'NL' ? text.slice(0, 4) : text;
}

type Saved = {saved: boolean; name: string; line1: string; line2: string; postal_code: string; city: string; country: string; phone: string};

/** The address to prefill: the newest saved one (the account lists saved addresses oldest first), else the newest order's. */
export function defaultAddress<T extends Pick<Saved, 'saved'>>(addresses: readonly T[] | null | undefined): T | null {
  const list = addresses ?? [];
  const saved = list.filter((a) => a.saved);
  return saved.length ? saved[saved.length - 1] : list[0] ?? null;
}

/**
 * Country precedence: the visitor's explicit pick (?country=) beats the signed-in buyer's default address, which beats
 * the request's country (Cloudflare); a country the app does not ship to is skipped. Null when none is shipped.
 */
export function prefillCountry(opts: {query?: string | null; saved?: string | null; geo?: string | null; ship: readonly string[]}): string | null {
  const ok = (c?: string | null) => {
    const u = (c ?? '').toUpperCase();
    return u && (!opts.ship.length || opts.ship.includes(u)) ? u : null;
  };
  return ok(opts.query) ?? ok(opts.saved) ?? ok(opts.geo);
}

/** The saved address fills the form only for the country it is in: another country asks for the address again. */
export function addressForCountry<T extends Pick<Saved, 'country'>>(address: T | null, country: string): T | null {
  return address && address.country.toUpperCase() === country.toUpperCase() ? address : null;
}
