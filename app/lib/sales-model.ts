/**
 * The shop's sales facts as one typed model. Pages never type these facts:
 * they read them from here.
 *
 * | Fact | Source |
 * |---|---|
 * | Where stock is held, per locale | `stockFrom` in `content/preorders.json` |
 * | Where stock ships | `paidRegions` in `content/preorders.json` |
 * | Which products sell from stock | a SKU with a `paid` batch in `content/preorders.json` |
 * | Which products sell as a preorder | every other SKU in `content/preorders.json` `skus` |
 * | The ship-by date of a preorder | `shipsBy`, or a batch's own `ships` ("ships by 31 May 2027") |
 * | The early-bird offer | `priceTiers`, ending with `endsOn` (`afterEndsOn` says what follows) |
 * | Which SKUs make up a product | `skus` in `content/products/<handle>.json` |
 * | A product's name in a list of lines | `lineName` in `content/products/<handle>.json` |
 * | Price, retail price, stock, Buy now variant | Shopify |
 *
 * The model is checked on load. A bad file stops the build and `npm test`
 * with a message that names the file and the field.
 *
 * Copy names a fact with a `{{token}}` placeholder (`SALES_TOKENS`);
 * `copy.ts` fills it in every copy string with `fillSalesTokens`.
 *
 * Relative imports only, so node:test loads it without Vite.
 */

import {
  fundingPromise,
  parseCampaignConfig,
  type AfterEndsOn,
  type CampaignConfig,
  type Region,
} from './preorder-campaign.ts';
import {PRODUCT_CONTENT, type ProductContent} from './product-content.ts';

export type SalesLocale = 'en' | 'nl' | 'fr';
const LOCALES: readonly SalesLocale[] = ['en', 'nl', 'fr'];

export type SalesModel = {
  /** Where stock is held, per locale: "Belgium", "België", "Belgique";
   *  French also with its preposition: "en Belgique", "depuis la Belgique". */
  stockFrom: Record<SalesLocale | 'frIn' | 'frFrom', string>;
  /** Where stock ships (`paidRegions`). */
  stockRegions: Region[];
  /** Product handles with a stock batch, in the order of `skus`. */
  stockProducts: string[];
  /** Product handles that sell only as a preorder, in the order of `skus`. */
  preorderProducts: string[];
  /** Every SKU `content/preorders.json` sells: `skus` and `shipsWith`. */
  skus: string[];
  /** Every SKU a product file lists (`skus` in `content/products/*.json`). */
  productSkus: string[];
  /** The latest ship-by day of any preorder batch, YYYY-MM-DD. Site-wide
   *  lines name it: every preorder ships by then. */
  shipsBy: string;
  /** The last day of the early-bird offer, YYYY-MM-DD. */
  offerEndsOn: string;
  /** What follows the offer: `retail` (no step), `earlyBird` or `closed`. */
  afterOffer: AfterEndsOn;
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "31 March 2027" as "2027-03-31"; null for anything else. */
function dayOf(longDate: string): string | null {
  const m = longDate.trim().match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/);
  const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (!m || month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function fail(message: string): never {
  throw new Error(`sales model: ${message}`);
}

/** SKU to product handle, from `skus` in the product files. */
export function skuProducts(products: Record<string, Pick<ProductContent, 'skus'>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [handle, content] of Object.entries(products)) {
    for (const sku of content.skus ?? []) {
      const other = out.get(sku);
      if (other) fail(`SKU ${sku} is listed by content/products/${other}.json and content/products/${handle}.json`);
      out.set(sku, handle);
    }
  }
  return out;
}

/**
 * The model from the raw `content/preorders.json` and the product files.
 * Throws on anything a page could not derive its words from.
 */
export function salesModel(
  raw: unknown,
  products: Record<string, Pick<ProductContent, 'skus' | 'lineName'>> = PRODUCT_CONTENT,
): SalesModel {
  let config: CampaignConfig;
  try {
    // parseCampaignConfig sets paid batch regions in place: parse a copy.
    config = parseCampaignConfig(structuredClone(raw));
  } catch (error) {
    fail(`content/preorders.json: ${(error as Error).message}`);
  }
  const from = (raw as {stockFrom?: unknown}).stockFrom;
  const fromKeys = [...LOCALES, 'frIn', 'frFrom'] as const;
  if (!from || typeof from !== 'object' || fromKeys.some((k) => typeof (from as Record<string, unknown>)[k] !== 'string' || !(from as Record<string, string>)[k].trim())) {
    fail('content/preorders.json: stockFrom must name the place stock is held as en, nl, fr, frIn ("en Belgique") and frFrom ("depuis la Belgique")');
  }
  // Pages follow paidRegions, but the Buy now lane, the cart's stock checks
  // and the order holds still test for the EU by name (preorder-campaign.ts
  // applyCampaign, shopify-cart-action.ts, preorder-fulfilment.ts).
  if ((config.paidRegions ?? ['EU']).join() !== 'EU') {
    fail('content/preorders.json: paidRegions other than ["EU"] needs the stock checks in code to read it first');
  }
  const owners = skuProducts(products);
  const stock: string[] = [];
  const preorder: string[] = [];
  let shipsBy = config.shipsBy;
  for (const [sku, entry] of Object.entries(config.skus)) {
    const handle = owners.get(sku);
    if (!handle) fail(`SKU ${sku} in content/preorders.json is in no product: add it to "skus" in content/products/<handle>.json`);
    if (!products[handle]?.lineName) fail(`content/products/${handle}.json needs a "lineName" (its name in a list of lines, "FC")`);
    const list = entry.batches.some((b) => b.paid) ? stock : preorder;
    if (!list.includes(handle)) list.push(handle);
    for (const batch of entry.batches) {
      if (batch.paid || !batch.ships) continue;
      const own = fundingPromise(batch.ships);
      const day = own ? dayOf(own.latestShip) : null;
      if (day && day > shipsBy) shipsBy = day;
    }
  }
  for (const [sku, rule] of Object.entries(config.shipsWith ?? {})) {
    if (!config.skus[rule.sku]) fail(`content/preorders.json: shipsWith ${sku} names ${rule.sku}, which is not in skus`);
  }
  return {
    stockFrom: {...(from as SalesModel['stockFrom'])},
    stockRegions: [...(config.paidRegions ?? ['EU'])],
    skus: [...new Set([...Object.keys(config.skus), ...Object.keys(config.shipsWith ?? {})])],
    productSkus: [...owners.keys()],
    // A product with stock and a preorder batch is a stock product.
    stockProducts: stock,
    preorderProducts: preorder.filter((h) => !stock.includes(h)),
    shipsBy,
    offerEndsOn: config.endsOn,
    afterOffer: config.afterEndsOn ?? 'retail',
  };
}

function loadFile(): unknown {
  if (import.meta.env) {
    const files = import.meta.glob<{default: unknown}>('/content/preorders.json', {eager: true});
    const file = Object.values(files)[0]?.default;
    if (file) return file;
  }
  const fs = (
    globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}}
  ).process?.getBuiltinModule?.('node:fs') as {readFileSync: (url: URL, encoding: string) => string} | undefined;
  if (!fs) fail('content/preorders.json is not readable here');
  // A joined path, so Vite does not emit the raw file as a public asset.
  return JSON.parse(fs.readFileSync(new URL(['..', '..', 'content', 'preorders.json'].join('/'), import.meta.url), 'utf8'));
}

/** The shop's model, from the files in this checkout. */
export const SALES: SalesModel = salesModel(loadFile());

/** "FC and ESC"; "RX, frames, motors" with `join: ', '`. */
function lineList(handles: readonly string[], products: Record<string, Pick<ProductContent, 'lineName'>>, join: 'and' | 'comma'): string {
  const names = handles.map((h) => products[h]?.lineName ?? h);
  if (join === 'comma' || names.length < 2) return names.join(', ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

const REGION_WORDS: Record<Region, string> = {EU: 'EU', US: 'US', NEAR: 'UK, Switzerland and Norway', INT: 'international'};

/** The day as "31 March 2027" (long) or "31 Mar 2027" (short), in a locale. */
export function salesDay(day: string, locale: SalesLocale = 'en', style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {day: 'numeric', month: style, year: 'numeric', timeZone: 'UTC'})
    .format(new Date(`${day}T12:00:00Z`))
    .replace('.', '');
}

/** The month of a day as "March 2027" (long) or "Mar 2027" (short), in a locale. */
export function salesMonth(day: string, locale: SalesLocale = 'en', style: 'long' | 'short' = 'long'): string {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : locale, {month: style, year: 'numeric', timeZone: 'UTC'})
    .format(new Date(`${day.slice(0, 7)}-01T12:00:00Z`))
    .replace('.', '');
}

/**
 * The words copy can name, English (the copy files are English):
 *
 * | Token | Today |
 * |---|---|
 * | `{{stock_from}}` | Belgium |
 * | `{{stock_scope}}` | EU |
 * | `{{stock_lines}}` | FC and ESC |
 * | `{{preorder_lines}}` | RX, frames, motors |
 * | `{{preorder_month}}` | March 2027 |
 * | `{{preorder_ships_by}}` | 31 March 2027 |
 */
export function salesTokens(
  model: SalesModel = SALES,
  products: Record<string, Pick<ProductContent, 'lineName'>> = PRODUCT_CONTENT,
): Record<string, string> {
  return {
    stock_from: model.stockFrom.en,
    stock_scope: model.stockRegions.map((r) => REGION_WORDS[r]).join(' and '),
    stock_lines: lineList(model.stockProducts, products, 'and'),
    preorder_lines: lineList(model.preorderProducts, products, 'comma'),
    preorder_month: salesMonth(model.shipsBy),
    preorder_ships_by: salesDay(model.shipsBy),
  };
}

const TOKENS = salesTokens();

/** `text` with every `{{token}}` filled; an unknown token stays as written,
 *  so a typo shows on the page and in the studio. */
export function fillSalesTokens(text: string, tokens: Record<string, string> = TOKENS): string {
  return text.includes('{{') ? text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => tokens[name] ?? match) : text;
}

/** The stock place of a locale: "Belgium", "België", "Belgique". */
export function stockFrom(locale: SalesLocale = 'en', model: SalesModel = SALES): string {
  return model.stockFrom[locale];
}

/** Whether stock ships to a region. */
export function stockShipsTo(region: Region, model: SalesModel = SALES): boolean {
  return model.stockProducts.length > 0 && model.stockRegions.includes(region);
}

let OWNERS: Map<string, string> | undefined;

/** A product line's name ("OpenFC Lite") from one of its SKUs, or null. */
export function productNameOfSku(
  sku: string | null | undefined,
  products: Record<string, Pick<ProductContent, 'skus' | 'name'>> = PRODUCT_CONTENT,
): string | null {
  if (!sku) return null;
  const handle = (products === PRODUCT_CONTENT ? (OWNERS ??= skuProducts(PRODUCT_CONTENT)) : skuProducts(products)).get(sku);
  return (handle && products[handle]?.name) || null;
}

/**
 * The sale mode of a SKU the Worker secret `SHOPIFY_PREVIEW_POLICY_JSON`
 * does not name, so opening or announcing a product line is a file entry,
 * not a secret edit:
 * - a SKU `content/preorders.json` sells: `preorder` (the campaign writes its
 *   promise, the stock lane included);
 * - a SKU only a product file lists (an announced product): `sold_out`;
 * - any other SKU: null, and the catalog still fails closed on it.
 */
export function defaultSalePolicy(sku: string, model: SalesModel = SALES): {saleMode: 'preorder' | 'sold_out'; shipPromise: null} | null {
  if (model.skus.includes(sku)) return {saleMode: 'preorder', shipPromise: null};
  if (model.productSkus.includes(sku)) return {saleMode: 'sold_out', shipPromise: null};
  return null;
}

/** Whether a product file announces a product that does not sell yet:
 *  `idea` or `development`. Pages show it with a notify-me and no cart button. */
export function announcedProduct(content: Pick<ProductContent, 'status'> | null | undefined): boolean {
  return content?.status === 'idea' || content?.status === 'development';
}

