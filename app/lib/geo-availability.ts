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
 * unchanged. The country is where the visitor orders to
 * (`geoCountryForRequest` in shipping-rates.ts: `?country=XX`, the picked
 * destination cookie the cart and allocation read, else `CF-IPCountry`), so a
 * visitor who switches destination reads that destination's line, and
 * LocationNotice says so once. In the `eu` region a batch 1 SKU is sold as
 * stock: "Add to cart", not "Pre-order" (`useGeoInStock`).
 *
 * Bundler-free (type-only imports) so the node:test suites can load it.
 */

import type {Locale} from './i18n.ts';
import {EU_COUNTRY_CODES, IMPORT_COUNTRY_CODES} from './eu-countries.ts';

/**
 * - `eu`: an EU member state: batch 1 stock, "In stock in Belgium, ships in a few days."
 * - `import`: UK, Switzerland, Norway (`IMPORT_COUNTRY_CODES`, allocation region NEAR):
 *   the March 2027 batch like `intl` (batch 1 is EU only, `paidRegions`), plus
 *   "Import VAT and duties are paid by you on delivery." (`GEO_DUTIES_NOTE`).
 * - `intl`: any other known country except the US: the March 2027 preorder batch only.
 * - `us`: on hold, "Not shipping to the US yet.", no ship promise.
 * - `fallback`: no known country: the batch promise itself.
 */
export type GeoAvailabilityRegion = 'eu' | 'import' | 'intl' | 'us' | 'fallback';
export type KnownGeoRegion = Exclude<GeoAvailabilityRegion, 'fallback'>;

const EU: ReadonlySet<string> = new Set(EU_COUNTRY_CODES);
const IMPORT: ReadonlySet<string> = new Set(IMPORT_COUNTRY_CODES);

/** The region of a visitor country (already validated, or null). */
export function geoAvailabilityRegion(country: string | null | undefined): GeoAvailabilityRegion {
  if (!country) return 'fallback';
  const code = country.toUpperCase();
  if (EU.has(code)) return 'eu';
  if (IMPORT.has(code)) return 'import';
  return code === 'US' ? 'us' : 'intl';
}

/** True for a region batch 1 stock ships to now: sold as stock, not as a pre-order. */
export function stockRegion(region: GeoAvailabilityRegion | null | undefined): boolean {
  return region === 'eu';
}

/** The line a visitor reads instead of the batch 1 promise, per locale. */
export const GEO_AVAILABILITY_COPY: Record<Locale, Record<KnownGeoRegion, string>> = {
  en: {
    eu: 'In stock in Belgium, ships in a few days.',
    import: 'Pre-order, ships March 2027.',
    intl: 'Pre-order, ships March 2027.',
    us: 'Not shipping to the US yet.',
  },
  nl: {
    eu: 'Op voorraad in België, wordt binnen enkele dagen verzonden.',
    import: 'Pre-order, verzending in maart 2027.',
    intl: 'Pre-order, verzending in maart 2027.',
    us: 'Nog geen verzending naar de VS.',
  },
  fr: {
    eu: 'En stock en Belgique, expédié sous quelques jours.',
    import: 'Précommande, expédition en mars 2027.',
    intl: 'Précommande, expédition en mars 2027.',
    us: 'Pas encore de livraison aux États-Unis.',
  },
};

/** The duties note of the `import` region: PDP buy box, cart, bar, location notice. */
export const GEO_DUTIES_NOTE: Record<Locale, string> = {
  en: 'Import VAT and duties are paid by you on delivery.',
  nl: 'Invoer-btw en invoerrechten betaal je zelf bij levering.',
  fr: 'La TVA à l’importation et les droits de douane sont à votre charge à la livraison.',
};

/** The duties note for a region, or null outside the `import` region. */
export function geoDutiesNote(region: GeoAvailabilityRegion | null | undefined, locale: Locale): string | null {
  return region === 'import' ? GEO_DUTIES_NOTE[locale] : null;
}

/** The line for a region, or null to keep the batch 1 promise (fallback). */
export function geoShipText(region: GeoAvailabilityRegion, locale: Locale): string | null {
  return region === 'fallback' ? null : GEO_AVAILABILITY_COPY[locale][region];
}

/** A region's line with its duties note: the bar and the location notice. */
export function geoFullLine(region: GeoAvailabilityRegion, locale: Locale): string | null {
  const line = geoShipText(region, locale);
  const duties = geoDutiesNote(region, locale);
  return line && duties ? `${line} ${duties}` : line;
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
  // US (on hold) keeps the offer as it is: crawlers come from the US, and an
  // OutOfStock there would read as out of stock everywhere.
  if (stockRegion(region)) return {availability: 'https://schema.org/InStock'};
  if (region === 'intl' || region === 'import') return {availability: 'https://schema.org/PreOrder', availabilityStarts: INTL_AVAILABILITY_STARTS};
  return null;
}

/** True when the buyer's next unit comes out of paid batch 1 stock (not once
 *  it is sold out, nor for a buyer whose region it does not ship to). */
export function hasBatchOne(campaign: {paidStock: boolean} | null | undefined): boolean {
  return Boolean(campaign?.paidStock);
}

/**
 * True when the visitor's next unit is batch 1 stock (`paidStock`, its
 * promise one of `batchOne`) and their region reads it as in stock: the EU.
 * The buy button then says "Add to cart", not "Pre-order".
 */
export function geoInStock(
  region: GeoAvailabilityRegion | null | undefined,
  campaign: {paidStock: boolean; shipPromise?: string | null} | null | undefined,
  batchOne: ReadonlySet<string>,
): boolean {
  return stockRegion(region) && hasBatchOne(campaign) && Boolean(campaign?.shipPromise && batchOne.has(campaign.shipPromise));
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
export const GEO_BANNER_COPY: Record<Locale, Record<KnownGeoRegion, string> & {title: string; dismiss: string}> = {
  en: {title: 'Availability', eu: 'EU', import: 'UK, CH, NO', intl: 'Elsewhere', us: 'US', dismiss: 'Dismiss the availability notice'},
  nl: {title: 'Beschikbaarheid', eu: 'EU', import: 'VK, CH, NO', intl: 'Elders', us: 'VS', dismiss: 'Melding over beschikbaarheid sluiten'},
  fr: {title: 'Disponibilité', eu: 'UE', import: 'R.-U., CH, NO', intl: 'Ailleurs', us: 'É.-U.', dismiss: 'Fermer l’avis de disponibilité'},
};

/** The shorter line per region for the bar on phones (one line, no wrap). */
export const GEO_BAR_SHORT: Record<Locale, Record<KnownGeoRegion, string>> = {
  en: {eu: 'In stock, ships in days', import: 'Mar 2027 + duties', intl: 'Pre-order, Mar 2027', us: 'Not shipping to the US yet'},
  nl: {eu: 'Op voorraad, binnen dagen verzonden', import: 'mrt 2027 + rechten', intl: 'Pre-order, verzending mrt 2027', us: 'Nog geen verzending naar de VS'},
  fr: {eu: 'En stock, expédié sous quelques jours', import: 'mars 2027 + droits', intl: 'Précommande, mars 2027', us: 'Pas encore de livraison aux É.-U.'},
};

/** The bar's one line: "EU: In stock in Belgium, ships in a few days" (the visitor's region), or both
 *  regions joined with " · " when the country is unknown. `short` is the phone line. Upper-cased by CSS. */
export function geoBarText(region: GeoAvailabilityRegion, locale: Locale, short: boolean): string {
  return geoBannerLines(region, locale)
    .map((l) => `${l.label}: ${(short ? GEO_BAR_SHORT[locale][l.region] : l.text).replace(/\.$/, '')}`)
    .join(' · ');
}

/** localStorage key of a dismissed banner; bump it when the lines change. */
export const GEO_BANNER_DISMISSED_KEY = 'od-availability-bar-v1';

/** Routes where the availability card is never rendered: tool and how-to pages, where a floating
 *  card over steps and buttons only gets in the way. Prefix match on whole segments, with or
 *  without a locale segment (the same en/nl/fr as i18n.ts LOCALES; that module is not
 *  importable from plain Node tests). */
const GEO_BANNER_EXCLUDED_ROOTS = ['flash', 'guides'] as const;
const PATH_LOCALES = new Set(['en', 'nl', 'fr']);

export function availabilityBannerHiddenOn(pathname: string): boolean {
  const segments = pathname.split('?')[0]!.split('#')[0]!.split('/').filter(Boolean);
  if (PATH_LOCALES.has(segments[0] ?? '')) segments.shift();
  return (GEO_BANNER_EXCLUDED_ROOTS as readonly string[]).includes((segments[0] ?? '').toLowerCase());
}

/**
 * The banner's lines: the visitor's own line when the country is known, both
 * lines when it is not. Every line carries its text label ("EU", "Outside
 * the EU"), so nothing depends on colour.
 */
export function geoBannerLines(
  region: GeoAvailabilityRegion,
  locale: Locale,
): Array<{region: KnownGeoRegion; label: string; text: string}> {
  const regions: KnownGeoRegion[] = region === 'fallback' ? ['eu', 'intl'] : [region];
  return regions.map((r) => ({region: r, label: GEO_BANNER_COPY[locale][r], text: geoFullLine(r, locale) ?? ''}));
}

/** The location notice (LocationNotice): "Shipping to Belgium: In stock in Belgium, ...", and its dismiss label. */
export const GEO_NOTICE_COPY: Record<Locale, {line: string; dismiss: string}> = {
  en: {line: 'Shipping to {country}: {line}', dismiss: 'Dismiss the shipping notice'},
  nl: {line: 'Verzending naar {country}: {line}', dismiss: 'Melding over verzending sluiten'},
  fr: {line: 'Livraison vers {country} : {line}', dismiss: 'Fermer l’avis de livraison'},
};

/**
 * True when a cart line is a pre-order for this visitor: it carries a ship
 * promise, and that promise is not batch 1 stock read as stock in their
 * region (`stockRegion`). "Early bird preorder prices." shows only then.
 */
export function geoPreorderLine(
  promise: string | null | undefined,
  region: GeoAvailabilityRegion | null | undefined,
  batchOne: ReadonlySet<string>,
): boolean {
  if (!promise) return false;
  return !(stockRegion(region) && batchOne.has(promise));
}

/**
 * The lines whose "Delivery by" date the parcel shows. A batch 1 line in a
 * stock region ships in a few days, so its late-November date drops; the US
 * (on hold) shows no date; elsewhere (`intl`, `fallback`) every line keeps its
 * own date. A line of another batch or a funding target always keeps it.
 */
export function geoDeliveryLines<T extends {shipPromise?: string | null}>(
  lines: readonly T[],
  region: GeoAvailabilityRegion | null | undefined,
  batchOne: ReadonlySet<string>,
): T[] {
  if (region === 'us') return [];
  if (!stockRegion(region)) return [...lines];
  return lines.filter((l) => !(l.shipPromise && batchOne.has(l.shipPromise)));
}
