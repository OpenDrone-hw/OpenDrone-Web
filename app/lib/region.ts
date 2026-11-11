/**
 * The visitor's region: one typed answer, resolved once per request on the
 * server (root loader) and read by every component through the root loader
 * data. No component decides region on its own.
 *
 * The country comes from `resolveCountry` (shipping-rates.ts), the one
 * precedence: blocked IP, then a `?country` link (turned into the choice on
 * landing), then the choice cookie, then CF-IPCountry, then the default.
 * Everything else here is a pure function of that country and the US gate,
 * so the server and the browser can never disagree (no hydration flip).
 *
 * The markets mirror what Shopify is configured to sell (Admin API, read
 * 2026-11-11, `npm run check:reach`): Shopify's "Belgium" and
 * "International" markets both sell in EUR with taxes in the price, its
 * "United States" market in USD with duties in the price. The site presents
 * four buyer-facing markets on top of them, each with its own honest tax
 * wording: EU, United States, UK / Switzerland / Norway (import VAT and
 * duties on delivery) and Rest of world (import charges on delivery).
 *
 * Lanes: `buyNow` is batch 1 stock in Belgium, EU only (bpost contract);
 * `preorder` is batch 2, every destination Shopify can ship to. The shipping
 * address at checkout still decides: Shopify configuration enforces it (PR
 * body, "Shopify settings").
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import {EU_COUNTRY_CODES, IMPORT_COUNTRY_CODES} from './eu-countries.ts';
import {REGISTRATIONS, type RegistrationsFile} from './registrations.ts';
import {resolveCountry, shippingQuote, type CountrySource} from './shipping-rates.ts';

const EU: ReadonlySet<string> = new Set(EU_COUNTRY_CODES);
const IMPORT: ReadonlySet<string> = new Set(IMPORT_COUNTRY_CODES);

/** The buyer-facing market. `none`: nothing can be bought for this country. */
export type MarketId = 'eu' | 'us' | 'import' | 'world' | 'none';

/** What the shown price includes. */
export type TaxShown =
  /** EU VAT included (Shopify taxes-included pricing; destination VAT under OSS is Shopify's tax setting). */
  | 'eu-vat-included'
  /** US: duties and import handling included, no US sales tax collected. */
  | 'us-duties-included'
  /** UK, CH, NO, rest of world: no local tax collected; import VAT, duties and fees are the buyer's on delivery. */
  | 'import-on-delivery';

/** Why a country cannot be sold to. */
export type NoShipReason =
  /** Sanctioned or refused (`BLOCKED_COUNTRIES`). */
  | 'blocked'
  /** An EU country not approved for consumer sale yet (`content/registrations.json`). */
  | 'not-approved'
  /** The US while `PUBLIC_US_SALES` is closed. */
  | 'us-closed'
  /** No Shopify market or shipping zone (`NO_SHOPIFY_ROUTE`), or a territory without addresses. */
  | 'no-route';

export type Region = {
  /** ISO 3166-1 alpha-2, or null when unknown (no IP country, VPN, Tor). */
  country: string | null;
  source: CountrySource;
  market: MarketId;
  /** Shopify's market handle that prices this country (`be`, `international`, `us`), null when none. */
  shopifyMarket: 'be' | 'international' | 'us' | null;
  currency: 'EUR' | 'USD';
  taxes: TaxShown;
  lanes: {buyNow: boolean; preorder: boolean};
  shipping: {available: true} | {available: false; reason: NoShipReason};
};

/** The markets the header control lists, in order. Only markets Shopify can
 *  sell to; the US only while its gate is open. */
export function listedMarkets(usOpen: boolean): Exclude<MarketId, 'none'>[] {
  return usOpen ? ['eu', 'us', 'import', 'world'] : ['eu', 'import', 'world'];
}

/**
 * The region for a country. `usOpen` is the US gate with its rate
 * (`usSalesRate(env) != null`). An unknown country (no IP country, VPN, Tor)
 * reads as the home market for prices (EU, EUR, VAT included) but gets the
 * pre-order lane only: batch 1 is promised to EU addresses, and an
 * "in stock" claim nobody can tie to a country is the riskier mistake (the
 * same rule as the geo ship line's `fallback`).
 */
export function regionFor(
  country: string | null,
  source: CountrySource,
  usOpen: boolean,
  registrations: RegistrationsFile = REGISTRATIONS,
): Region {
  const code = country?.trim().toUpperCase() || null;
  const base = {country: code, source};
  if (!code) {
    return {...base, market: 'eu', shopifyMarket: 'be', currency: 'EUR', taxes: 'eu-vat-included', lanes: {buyNow: false, preorder: true}, shipping: {available: true}};
  }
  const quote = shippingQuote(code, registrations, usOpen ? 1 : null);
  const none = (reason: NoShipReason, market: Region['shopifyMarket'] = null, currency: Region['currency'] = 'EUR'): Region => ({
    ...base,
    market: 'none',
    shopifyMarket: market,
    currency,
    taxes: EU.has(code) ? 'eu-vat-included' : 'import-on-delivery',
    lanes: {buyNow: false, preorder: false},
    shipping: {available: false, reason},
  });
  if (!quote || quote.kind === 'blocked') return none('blocked');
  if (quote.kind === 'closed') return none('not-approved', code === 'BE' ? 'be' : 'international');
  if (quote.kind === 'shops') return code === 'US' ? none('us-closed', 'us', 'EUR') : none('no-route');
  if (EU.has(code)) {
    return {...base, market: 'eu', shopifyMarket: code === 'BE' ? 'be' : 'international', currency: 'EUR', taxes: 'eu-vat-included', lanes: {buyNow: true, preorder: true}, shipping: {available: true}};
  }
  if (code === 'US') {
    return {...base, market: 'us', shopifyMarket: 'us', currency: 'USD', taxes: 'us-duties-included', lanes: {buyNow: false, preorder: true}, shipping: {available: true}};
  }
  return {
    ...base,
    market: IMPORT.has(code) ? 'import' : 'world',
    shopifyMarket: 'international',
    currency: 'EUR',
    taxes: 'import-on-delivery',
    lanes: {buyNow: false, preorder: true},
    shipping: {available: true},
  };
}

/** The region of this request: `resolveCountry`, then `regionFor`. */
export function resolveRegion(request: Request, usOpen: boolean, registrations?: RegistrationsFile): Region {
  const {country, source} = resolveCountry(request);
  return regionFor(country, source, usOpen, registrations);
}

/**
 * The country the header control stores for a market. EU keeps the current
 * country when it is an EU country sold direct, else Belgium; US is "US";
 * UK / CH / NO keeps the current one of those, else GB; Rest of world keeps
 * the current rest-of-world country, else the visitor's IP country when that
 * is one, else null (the control then asks for the country in the cart's
 * Ship to list instead of guessing one).
 */
export function marketCountry(
  market: Exclude<MarketId, 'none'>,
  current: Region,
  ipCountry: string | null,
  usOpen: boolean,
  registrations: RegistrationsFile = REGISTRATIONS,
): string | null {
  const keep = (code: string | null | undefined) =>
    code && regionFor(code, 'choice', usOpen, registrations).market === market ? code : null;
  if (market === 'us') return usOpen ? 'US' : null;
  if (market === 'eu') return keep(current.country) ?? 'BE';
  if (market === 'import') return keep(current.country) ?? keep(ipCountry) ?? 'GB';
  return keep(current.country) ?? keep(ipCountry);
}
