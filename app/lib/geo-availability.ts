/**
 * The batch 1 ship line by visitor country, and the schema.org availability
 * that goes with it, so the copy and the structured data never disagree.
 *
 * - `eu`: Cloudflare's `CF-IPCountry` is an EU member state (the one list,
 *   `eu-countries.ts`): "In stock in Belgium, ships in a few days." InStock.
 * - `intl`: any other known country: "Pre-order, ships March 2027."
 *   PreOrder, available from March 2027.
 * - `fallback`: no header or an unknown country (`XX`, Tor): no override.
 *   The line stays the batch 1 promise of `content/preorders.json` (#784,
 *   "Ships late Nov 2026") and the offer keeps its PreOrder availability: an
 *   "in stock" claim nobody can tie to a country is the riskier mistake.
 *
 * The line replaces the batch 1 promise wherever a ship chip or ship line
 * shows it (product page, availability rows, cart, added-to-cart dialog);
 * the promise text itself, the checkout line property and the allocation are
 * unchanged. The country comes from `visitorCountry` (the header, with
 * `?country=XX` to check a page as seen from elsewhere), not from the ship-to
 * cookie the cart and allocation read.
 *
 * Bundler-free (type-only imports) so the node:test suites can load it.
 */

import type {Locale} from './i18n.ts';
import {EU_COUNTRY_CODES} from './eu-countries.ts';

export type GeoAvailabilityRegion = 'eu' | 'intl' | 'fallback';

const EU: ReadonlySet<string> = new Set(EU_COUNTRY_CODES);

/** The region of a visitor country (already validated, or null). */
export function geoAvailabilityRegion(country: string | null | undefined): GeoAvailabilityRegion {
  if (!country) return 'fallback';
  return EU.has(country.toUpperCase()) ? 'eu' : 'intl';
}

/** The line a visitor reads instead of the batch 1 promise, per locale. */
export const GEO_AVAILABILITY_COPY: Record<Locale, Record<Exclude<GeoAvailabilityRegion, 'fallback'>, string>> = {
  en: {
    eu: 'In stock in Belgium, ships in a few days.',
    intl: 'Pre-order, ships March 2027.',
  },
  nl: {
    eu: 'Op voorraad in België, wordt binnen enkele dagen verzonden.',
    intl: 'Pre-order, verzending in maart 2027.',
  },
  fr: {
    eu: 'En stock en Belgique, expédié sous quelques jours.',
    intl: 'Précommande, expédition en mars 2027.',
  },
};

/** The line for a region, or null to keep the batch 1 promise (fallback). */
export function geoShipText(region: GeoAvailabilityRegion, locale: Locale): string | null {
  return region === 'fallback' ? null : GEO_AVAILABILITY_COPY[locale][region];
}

/** schema.org Offer fields that match the line of a region. */
export type GeoOfferAvailability = {
  availability: 'https://schema.org/InStock' | 'https://schema.org/PreOrder';
  availabilityStarts?: string;
};

/** First day of the March 2027 promise; a test checks it against `content/preorders.json`. */
export const INTL_AVAILABILITY_STARTS = '2027-03-01';

/** The offer fields of a region, or null to keep the offer as it is (fallback). */
export function geoOfferAvailability(region: GeoAvailabilityRegion): GeoOfferAvailability | null {
  if (region === 'eu') return {availability: 'https://schema.org/InStock'};
  if (region === 'intl') return {availability: 'https://schema.org/PreOrder', availabilityStarts: INTL_AVAILABILITY_STARTS};
  return null;
}

/** True when the buyer's next unit comes out of paid batch 1 stock (not once
 *  it is sold out, nor for a buyer whose region it does not ship to). */
export function hasBatchOne(campaign: {paidStock: boolean} | null | undefined): boolean {
  return Boolean(campaign?.paidStock);
}

/** The ship promises of paid batch 1 stock in `content/preorders.json`. */
export function batchOnePromises(config: {skus: Record<string, {batches: ReadonlyArray<{paid?: boolean; ships?: string; [key: string]: unknown}>}>}): ReadonlySet<string> {
  const out = new Set<string>();
  for (const sku of Object.values(config.skus)) for (const b of sku.batches) if (b.paid && b.ships) out.add(b.ships);
  return out;
}

/**
 * One Offer's availability: sold out stays OutOfStock; a batch 1 offer takes
 * the visitor's region when there is one (`geo`); otherwise a pre-order is
 * PreOrder and the rest InStock.
 */
export function offerAvailability(
  offer: {availableForSale: boolean; preorder: boolean; batchOne: boolean},
  geo: GeoOfferAvailability | null,
): {availability: string; availabilityStarts?: string} {
  if (!offer.availableForSale) return {availability: 'https://schema.org/OutOfStock'};
  if (offer.batchOne && geo) return {...geo};
  return {availability: offer.preorder ? 'https://schema.org/PreOrder' : 'https://schema.org/InStock'};
}

/** The site-wide availability banner: its heading, line labels and dismiss label. */
export const GEO_BANNER_COPY: Record<Locale, {title: string; eu: string; intl: string; dismiss: string}> = {
  en: {title: 'Availability', eu: 'EU', intl: 'Outside the EU', dismiss: 'Dismiss the availability notice'},
  nl: {title: 'Beschikbaarheid', eu: 'EU', intl: 'Buiten de EU', dismiss: 'Melding over beschikbaarheid sluiten'},
  fr: {title: 'Disponibilité', eu: 'UE', intl: 'Hors UE', dismiss: 'Fermer l’avis de disponibilité'},
};

/** localStorage key of a dismissed banner; bump it when the lines change. */
export const GEO_BANNER_DISMISSED_KEY = 'od-availability-banner-v1';

/**
 * The banner's lines: the visitor's own line when the country is known, both
 * lines when it is not. Every line carries its text label ("EU", "Outside
 * the EU"), so nothing depends on colour.
 */
export function geoBannerLines(
  region: GeoAvailabilityRegion,
  locale: Locale,
): Array<{region: 'eu' | 'intl'; label: string; text: string}> {
  const regions: Array<'eu' | 'intl'> = region === 'fallback' ? ['eu', 'intl'] : [region];
  return regions.map((r) => ({region: r, label: GEO_BANNER_COPY[locale][r], text: GEO_AVAILABILITY_COPY[locale][r]}));
}
