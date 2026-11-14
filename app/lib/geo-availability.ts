/**
 * The batch 1 ship line by visitor country, and the schema.org availability
 * that goes with it, so the copy and the structured data never disagree.
 *
 * - `eu`: Cloudflare's `CF-IPCountry` is an EU member state (the one list,
 *   `eu-countries.ts`): "In stock in Belgium, ships in a few working days." InStock.
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
import {CAMPAIGN_SHIPS_BY} from './campaign-file.ts';
import {EU_COUNTRY_CODES, IMPORT_COUNTRY_CODES} from './eu-countries.ts';

/**
 * - `eu`: an EU member state: batch 1 stock, "In stock in Belgium, ships in a few working days."
 * - `import`: UK, Switzerland, Norway (`IMPORT_COUNTRY_CODES`, allocation region NEAR):
 *   the March 2027 batch like `intl` (batch 1 is EU only, `paidRegions`), plus
 *   "Import VAT and duties: paid by you on delivery, unless collected at checkout." (`GEO_DUTIES_NOTE`).
 * - `intl`: any other known country except the US: the March 2027 preorder batch only.
 * - `us`: only while US sales are closed (`PUBLIC_US_SALES`): "Not shipping to the US yet.", no ship promise.
 *   Open, the US is `intl`.
 * - `fallback`: no known country: the batch promise itself.
 */
export type GeoAvailabilityRegion = 'eu' | 'import' | 'intl' | 'us' | 'fallback';
export type KnownGeoRegion = Exclude<GeoAvailabilityRegion, 'fallback'>;

const EU: ReadonlySet<string> = new Set(EU_COUNTRY_CODES);
const IMPORT: ReadonlySet<string> = new Set(IMPORT_COUNTRY_CODES);

/**
 * The region of a visitor country (already validated, or null). `usOpen` is
 * the US sales gate with its rate (`usSalesRate`, the root loader's
 * `usShippingRate`): open, the US reads the March 2027 batch like every other
 * destination outside the EU (duties are in its price, so no duties note);
 * closed, it reads "Not shipping to the US yet."
 */
export function geoAvailabilityRegion(country: string | null | undefined, usOpen = false): GeoAvailabilityRegion {
  if (!country) return 'fallback';
  const code = country.toUpperCase();
  if (EU.has(code)) return 'eu';
  if (IMPORT.has(code)) return 'import';
  return code === 'US' && !usOpen ? 'us' : 'intl';
}

/** True for a region batch 1 stock ships to now: sold as stock, not as a pre-order. */
export function stockRegion(region: GeoAvailabilityRegion | null | undefined): boolean {
  return region === 'eu';
}

/** First day of the pre-order batch's ship month, from `shipsBy` in
 *  `content/preorders.json`. Every month in the lines below is read from it,
 *  so no line names a batch month of its own. */
export const INTL_AVAILABILITY_STARTS = `${CAMPAIGN_SHIPS_BY.slice(0, 7)}-01`;

/** The pre-order batch's month in a locale: "March 2027", "maart 2027"; short: "Mar 2027", "mrt 2027". */
export function shipMonth(locale: Locale, style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {month: style, year: 'numeric', timeZone: 'UTC'})
    .format(new Date(`${INTL_AVAILABILITY_STARTS}T12:00:00Z`))
    .replace('.', '');
}

/** The line a visitor reads instead of the batch 1 promise, per locale. */
export const GEO_AVAILABILITY_COPY: Record<Locale, Record<KnownGeoRegion, string>> = {
  en: {
    eu: 'In stock in Belgium, ships in a few working days.',
    import: `Pre-order, ships ${shipMonth('en')}.`,
    intl: `Pre-order, ships ${shipMonth('en')}.`,
    us: 'Not shipping to the US yet.',
  },
  nl: {
    eu: 'Op voorraad in België, wordt binnen enkele werkdagen verzonden.',
    import: `Pre-order, verzending in ${shipMonth('nl')}.`,
    intl: `Pre-order, verzending in ${shipMonth('nl')}.`,
    us: 'Nog geen verzending naar de VS.',
  },
  fr: {
    eu: 'En stock en Belgique, expédié sous quelques jours ouvrables.',
    import: `Précommande, expédition en ${shipMonth('fr')}.`,
    intl: `Précommande, expédition en ${shipMonth('fr')}.`,
    us: 'Pas encore de livraison aux États-Unis.',
  },
};

/** The duties note of the `import` region: PDP buy box, cart, bar, location notice. */
export const GEO_DUTIES_NOTE: Record<Locale, string> = {
  en: 'Import VAT and duties: paid by you on delivery, unless collected at checkout.',
  nl: 'Invoer-btw en invoerrechten: bij levering door jou betaald, tenzij geïnd bij de checkout.',
  fr: 'TVA à l’importation et droits : à votre charge à la livraison, sauf s’ils sont perçus au paiement.',
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


/**
 * Where an Offer is not sold: the US while US sales are on hold (no US rate),
 * so no visitor or crawler reads an InStock or PreOrder offer as orderable
 * from the US. Spread into every Offer of the product's structured data.
 */
export function offerRegionRestriction(usSalesOpen: boolean): {ineligibleRegion?: Array<{'@type': 'Country'; name: string}>} {
  return usSalesOpen ? {} : {ineligibleRegion: [{'@type': 'Country', name: 'US'}]};
}

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
export function batchOnePromises(config: {
  skus: Record<string, {batches: ReadonlyArray<{paid?: boolean; ships?: string; [key: string]: unknown}>}>;
  soldUnder?: unknown;
}): ReadonlySet<string> {
  const out = new Set<string>();
  for (const sku of Object.values(config.skus)) for (const b of sku.batches) if (b.paid && b.ships) out.add(b.ships);
  // The wording batch 1 was sold under before (`soldUnder` in preorders.json,
  // "ships late November 2026"): a cart line or order that still carries it
  // is the same stock.
  const eras = config.soldUnder === undefined ? [] : Array.isArray(config.soldUnder) ? config.soldUnder : [config.soldUnder];
  if (out.size) for (const era of eras as Array<{paidShips?: unknown}>) if (typeof era?.paidShips === 'string' && era.paidShips) out.add(era.paidShips);
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

const GEO_BAR_SHORT_EU: Record<Locale, string> = {en: 'In stock, ships in days', nl: 'Op voorraad, binnen dagen verzonden', fr: 'En stock, expédié sous quelques jours'};

/** The shorter line per region for the bar on phones (one line, no wrap). */
export const GEO_BAR_SHORT: Record<Locale, Record<KnownGeoRegion, string>> = {
  en: {eu: GEO_BAR_SHORT_EU.en, import: `${shipMonth('en', 'short')} + duties`, intl: `Pre-order, ${shipMonth('en', 'short')}`, us: 'Not shipping to the US yet'},
  nl: {eu: GEO_BAR_SHORT_EU.nl, import: `${shipMonth('nl', 'short')} + rechten`, intl: `Pre-order, verzending ${shipMonth('nl', 'short')}`, us: 'Nog geen verzending naar de VS'},
  fr: {eu: GEO_BAR_SHORT_EU.fr, import: `${shipMonth('fr')} + droits`, intl: `Précommande, ${shipMonth('fr')}`, us: 'Pas encore de livraison aux É.-U.'},
};

/** The bar once nothing is pre-order any more (the "ordinary shop", `catalogHasPreorders` false):
 *  stock everywhere the shop ships, no batch month. Long and short (phone) line per region. */
export const GEO_STOCK_COPY: Record<Locale, Record<KnownGeoRegion, {long: string; short: string}>> = {
  en: {
    eu: {long: GEO_AVAILABILITY_COPY.en.eu, short: GEO_BAR_SHORT_EU.en},
    import: {long: `In stock in Belgium, ships worldwide. ${GEO_DUTIES_NOTE.en}`, short: 'In stock + duties'},
    intl: {long: 'In stock in Belgium, ships worldwide.', short: 'In stock, ships worldwide'},
    us: {long: GEO_AVAILABILITY_COPY.en.us, short: 'Not shipping to the US yet'},
  },
  nl: {
    eu: {long: GEO_AVAILABILITY_COPY.nl.eu, short: GEO_BAR_SHORT_EU.nl},
    import: {long: `Op voorraad in België, wereldwijd verzonden. ${GEO_DUTIES_NOTE.nl}`, short: 'Op voorraad + rechten'},
    intl: {long: 'Op voorraad in België, wereldwijd verzonden.', short: 'Op voorraad, wereldwijd verzonden'},
    us: {long: GEO_AVAILABILITY_COPY.nl.us, short: 'Nog geen verzending naar de VS'},
  },
  fr: {
    eu: {long: GEO_AVAILABILITY_COPY.fr.eu, short: GEO_BAR_SHORT_EU.fr},
    import: {long: `En stock en Belgique, expédié dans le monde entier. ${GEO_DUTIES_NOTE.fr}`, short: 'En stock + droits'},
    intl: {long: 'En stock en Belgique, expédié dans le monde entier.', short: 'En stock, expédié partout'},
    us: {long: GEO_AVAILABILITY_COPY.fr.us, short: 'Pas encore de livraison aux É.-U.'},
  },
};

/** The pre-order batch's ship-by day: `shipsBy` in `content/preorders.json`. */
export const PREORDER_SHIPS_BY = CAMPAIGN_SHIPS_BY;

/** "31 March 2027" (long) or "31 Mar 2027" (short) in a locale. */
export function shipByDate(locale: Locale, style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {day: 'numeric', month: style, year: 'numeric', timeZone: 'UTC'})
    .format(new Date(`${PREORDER_SHIPS_BY}T12:00:00Z`))
    .replace('.', '');
}

/** The bar's lines: the visitor's availability, nothing about markets or
 *  taxes (those are on /markets). Long for laptops, short for phones. */
const BAR: Record<Locale, {stock: [string, string]; preorder: (style: 'long' | 'short') => string; anywhere: [string, string]}> = {
  en: {
    stock: ['In stock in Belgium, ships in days', 'In stock, ships in days'],
    preorder: (style) => `Pre-order, ships by ${shipByDate('en', style)}`,
    anywhere: ['In stock, ships worldwide from Belgium', 'In stock, ships worldwide'],
  },
  nl: {
    stock: ['Op voorraad in België, binnen enkele dagen verzonden', 'Op voorraad, binnen dagen verzonden'],
    preorder: (style) => (style === 'long' ? `Pre-order, verzending uiterlijk ${shipByDate('nl')}` : `Pre-order, uiterlijk ${shipByDate('nl', 'short')}`),
    anywhere: ['Op voorraad, wereldwijd verzonden vanuit België', 'Op voorraad, wereldwijd verzonden'],
  },
  fr: {
    stock: ['En stock en Belgique, expédié sous quelques jours', 'En stock, expédié sous quelques jours'],
    preorder: (style) => (style === 'long' ? `Précommande, expédition au plus tard le ${shipByDate('fr')}` : `Précommande, au plus tard ${shipByDate('fr', 'short')}`),
    anywhere: ['En stock, expédié partout depuis la Belgique', 'En stock, expédié partout'],
  },
};

/**
 * The bar's one line for the visitor's region: "In stock in Belgium, ships
 * in days" (EU), "Pre-order, ships by 31 March 2027" (everywhere else,
 * and a visitor with no known country, who can only pre-order), "Not
 * shipping to the US yet" (US while closed). `ordinary`: nothing is
 * pre-order any more, stock ships everywhere. A country the shop cannot sell
 * to reads the buy box's own words instead (PageLayout `note`). `short` is
 * the phone line. Upper-cased by CSS.
 */
export function geoBarText(region: GeoAvailabilityRegion, locale: Locale, short: boolean, ordinary = false): string {
  const at = short ? 1 : 0;
  const words = BAR[locale];
  if (region === 'us') return (short ? GEO_BAR_SHORT[locale].us : GEO_AVAILABILITY_COPY[locale].us).replace(/\.$/, '');
  if (region === 'eu') return words.stock[at];
  return ordinary ? words.anywhere[at] : words.preorder(short ? 'short' : 'long');
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
 * stock region ships in a few working days, so its late-November date drops; the US
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
