/**
 * The Odoo catalog: types, lookups and the mapping onto the product
 * shapes this app's components consume.
 *
 * One public JSON endpoint (`CATALOG_URL`, served by the Odoo module
 * `incutec_catalog_api`) owns handles, titles, images, prices, compare
 * prices, availability, ship promises, ratings and the ready-made
 * hand-off links. Editorial content stays in `content/products/*.json`
 * and is merged by handle: Odoo never carries the story, this repository
 * never carries a price.
 *
 * Kept pure and bundler-free (relative imports, no worker APIs) so the
 * node:test suites can load it. The fetching and caching half lives in
 * `app/lib/catalog-client.ts`.
 *
 * The contract this implements: `erp/docs/storefront-contract.md`.
 */

import type {
  CartLine,
  CatalogAvailability,
  CatalogFunding,
  MappedProductOptions,
  MoneyV2,
  ProductCardFragment,
  ProductFragment,
  ProductImage,
  ProductVariantFragment,
} from './product-shapes.ts';
import {PRODUCT_CONTENT} from './product-content.ts';
import {toStorefrontImageUrl} from './odoo-image.ts';

export type {CartLine, CatalogAvailability, CatalogFunding};

export type CatalogVariant = {
  sku: string;
  title: string;
  model: string | null;
  options: Record<string, string>;
  price: number;
  compare_price: number | null;
  currency: string;
  availability: CatalogAvailability;
  ship_promise: string | null;
  /** Design revision stage of this variant (schema 2), or null. */
  stage?: string | null;
  /** Promotional discount on this variant (schema addition), or null.
   *  Wire shape from `incutec_catalog_api`; `mapVariant` carries it onto
   *  the mapped variant as camelCase. */
  discount?: {
    label: string | null;
    ends_at: string | null;
    units_left: number | null;
  } | null;
  image: string | null;
  url: string;
  cart_add_url: string;
  cart_add_method?: 'POST';
  /** Older catalogs carried an issued DoC object here. It is ignored:
   *  Declarations of Conformity stay internal (contract section 4). */
  compliance?: unknown;
};

export type CatalogProduct = {
  handle: string;
  title: string;
  family: string | null;
  description: string | null;
  url: string;
  images: string[];
  rating: {average: number; count: number} | null;
  variants: CatalogVariant[];
  /** Odoo's product stage, e.g. "concept" or "production". */
  stage?: string | null;
  /** Funded pre-order progress, or null/absent for an ordinary product. */
  funding?: CatalogFunding | null;
};

export type Catalog = {
  schema: number;
  generated_at: string;
  max_age: number;
  currency: string;
  prices_include_vat: boolean;
  shop_url: string;
  cart_url: string;
  add_url: string;
  add_method?: 'POST';
  products: CatalogProduct[];
};

/** The shape a failed fetch degrades to: a valid, empty catalog. */
export function emptyCatalog(shopUrl: string): Catalog {
  const base = shopUrl.replace(/\/+$/, '');
  return {
    schema: 1,
    generated_at: new Date(0).toISOString(),
    max_age: 300,
    currency: 'EUR',
    prices_include_vat: true,
    shop_url: base,
    cart_url: `${base}/shop/cart`,
    add_url: `${base}/incutec/add`,
    add_method: 'POST',
    products: [],
  };
}

const FUNDING_STATES: ReadonlySet<string> = new Set([
  'draft',
  'open',
  'funded',
  'missed',
  'cancelled',
]);

/**
 * Normalize a product's raw `funding` field. Missing or malformed input
 * (wrong types, an unknown `state`) maps to null rather than throwing, so
 * one bad product never fails the whole catalog fetch.
 */
function normalizeFunding(raw: unknown): CatalogFunding | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  if (
    // `typeof NaN === 'number'`, so the numbers are range-checked as well
    // as type-checked: NaN or Infinity would reach the meter as a bar of
    // `width: NaN%` and `aria-valuenow="NaN"`.
    typeof f.target_units !== 'number' ||
    !Number.isFinite(f.target_units) ||
    typeof f.units_funded !== 'number' ||
    !Number.isFinite(f.units_funded) ||
    // Kept for contract compatibility with the wire shape and still
    // range-checked here, but `fundingPct` (funding.ts) derives the
    // displayed percentage from unitsFunded/targetUnits instead: nothing
    // reads this field for display any more.
    typeof f.pct !== 'number' ||
    !Number.isFinite(f.pct) ||
    // A target of zero or less is not a campaign: it reads "0 of 0 funded"
    // and it is what a division by zero on the Odoo side looks like here.
    f.target_units <= 0 ||
    typeof f.state !== 'string' ||
    !FUNDING_STATES.has(f.state)
  ) {
    return null;
  }
  return {
    targetUnits: f.target_units,
    unitsFunded: f.units_funded,
    pct: f.pct,
    state: f.state as CatalogFunding['state'],
    dateDeadline: typeof f.date_deadline === 'string' ? f.date_deadline : null,
    // Schema 2 additions, each checked on its own so one missing or
    // malformed field never costs the campaign the ones that parsed. A
    // schema-1 product carries none of them and reads null across the
    // board, which is what every display helper already handles.
    dateOpen: typeof f.date_open === 'string' ? f.date_open : null,
    backers:
      typeof f.backers === 'number' && Number.isFinite(f.backers) && f.backers >= 0
        ? f.backers
        : null,
    amountFunded:
      typeof f.amount_funded === 'number' &&
      Number.isFinite(f.amount_funded) &&
      f.amount_funded >= 0
        ? f.amount_funded
        : null,
    currency: typeof f.currency === 'string' && f.currency ? f.currency : null,
  };
}

/**
 * Normalize a variant's raw `discount` field. Anything that is not a
 * plain object (missing, null, a string, a number) maps to null, same as
 * `stage`; a present object gets each sub-field type-checked independently
 * so one bad field never drops a label/date/count that parsed fine.
 */
function normalizeDiscount(raw: unknown): NonNullable<CatalogVariant['discount']> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  return {
    label: typeof d.label === 'string' ? d.label : null,
    ends_at: typeof d.ends_at === 'string' ? d.ends_at : null,
    units_left:
      typeof d.units_left === 'number' && Number.isFinite(d.units_left)
        ? d.units_left
        : null,
  };
}

/**
 * Normalize the additive `stage`/`funding` fields on one raw product.
 * Everything else on the product passes through untouched, so an old
 * schema-1 catalog (neither field present) parses exactly as before.
 */
function normalizeProduct(raw: unknown): CatalogProduct {
  // A product entry that is not an object (null, a string, a number) must
  // not throw: one malformed product costs the site every price, not one
  // meter, because the whole catalog fetch fails with it.
  if (!raw || typeof raw !== 'object') {
    return {stage: null, funding: null} as CatalogProduct;
  }
  const p = raw as CatalogProduct & Record<string, unknown>;
  // A schema-1 product always has a variants array; anything else is left
  // untouched so this normalizer never changes what an old catalog parses to.
  const variants = Array.isArray(p.variants)
    ? p.variants.map((v) =>
        v && typeof v === 'object'
          ? {
              ...v,
              stage: typeof v.stage === 'string' ? v.stage : null,
              discount: normalizeDiscount(v.discount),
            }
          : v,
      )
    : p.variants;
  return {
    ...p,
    variants,
    stage: typeof p.stage === 'string' ? p.stage : null,
    funding: normalizeFunding(p.funding),
  };
}

/**
 * Accept a parsed JSON body as a catalog, or throw. Deliberately narrow:
 * a 200 with a login page or an error document must not become an empty
 * catalog that silently unprices the whole site.
 */
export function parseCatalog(body: unknown): Catalog {
  const c = body as Partial<Catalog> | null;
  if (!c || typeof c !== 'object' || !Array.isArray(c.products)) {
    throw new Error('catalog: response is not a catalog document');
  }
  if (!c.shop_url || !c.add_url) {
    throw new Error('catalog: response is missing shop_url or add_url');
  }
  return {...c, products: c.products.map(normalizeProduct)} as Catalog;
}

export function byHandle(
  catalog: Catalog,
  handle: string | null | undefined,
): CatalogProduct | null {
  if (!handle) return null;
  return catalog.products.find((p) => p.handle === handle) ?? null;
}

export function bySku(
  catalog: Catalog,
  sku: string | null | undefined,
): {product: CatalogProduct; variant: CatalogVariant} | null {
  if (!sku) return null;
  for (const product of catalog.products) {
    const variant = product.variants.find((v) => v.sku === sku);
    if (variant) return {product, variant};
  }
  return null;
}

/**
 * The display family for a product: the local content file's `family`
 * first (it is the word the site has always shown), then Odoo's public
 * category, then nothing.
 */
export function familyOf(product: CatalogProduct): string | null {
  return PRODUCT_CONTENT[product.handle]?.family ?? product.family ?? null;
}

/**
 * Products grouped by family, in catalog order, for the header pods.
 * Products with no family land under one empty-string key so a
 * mis-categorised product is never dropped from the menu.
 */
export function familyGroups(
  catalog: Catalog,
): Array<{family: string; products: CatalogProduct[]}> {
  const groups = new Map<string, CatalogProduct[]>();
  for (const product of catalog.products) {
    const family = familyOf(product) ?? '';
    const list = groups.get(family);
    if (list) list.push(product);
    else groups.set(family, [product]);
  }
  return [...groups].map(([family, products]) => ({family, products}));
}

/** Odoo's availability word as a buyable flag. */
export function availabilityToAvailableForSale(
  availability: CatalogAvailability,
): boolean {
  return availability !== 'sold_out';
}

/**
 * Build the action and fields for the shop's POST hand-off form (contract
 * section 3): `/incutec/add` rejects state-changing GETs so crawlers and
 * link previewers cannot create carts. One line uses the `sku`/`qty` pair,
 * several use `lines`. `AddToCartButton` turns the query string this
 * returns into hidden form fields submitted with `method="post"`.
 *
 * `addUrl` is the catalog's `add_url`; callers that only hold the shop
 * base pass `${shopUrl}/incutec/add`.
 */
export function cartAddUrl(
  addUrl: string,
  lines: CartLine[],
  opts?: {next?: string; mode?: 'add' | 'set'},
): string {
  const clean = lines
    .map((l) => ({
      sku: (l.sku ?? '').trim(),
      quantity: Math.min(50, Math.max(1, Math.round(l.quantity ?? 1))),
    }))
    .filter((l) => l.sku.length > 0)
    .slice(0, 20);
  const params = new URLSearchParams();
  if (clean.length === 1) {
    params.set('sku', clean[0].sku);
    params.set('qty', String(clean[0].quantity));
  } else if (clean.length > 1) {
    params.set('lines', clean.map((l) => `${l.sku}:${l.quantity}`).join(','));
  }
  if (opts?.mode) params.set('mode', opts.mode);
  params.set('next', opts?.next ?? 'cart');
  return `${addUrl}?${params.toString()}`;
}

/** `39.99` -> `"39.99"`, the string form every price surface expects. */
function money(amount: number, currency: string): MoneyV2 {
  return {amount: amount.toFixed(2), currencyCode: currency};
}

function image(url: string | null, alt: string, index = 0): ProductImage | null {
  if (!url) return null;
  // Odoo image URLs become the same-origin cached route (odoo-image.ts), so a
  // slow or restarting Odoo never breaks a gallery.
  const src = toStorefrontImageUrl(url);
  return {id: `${src}#${index}`, url: src, altText: alt, width: null, height: null};
}

function variantId(sku: string): string {
  return `odoo:variant:${sku}`;
}

function mapVariant(
  catalog: Catalog,
  product: CatalogProduct,
  variant: CatalogVariant,
): ProductVariantFragment {
  return {
    id: variantId(variant.sku),
    sku: variant.sku,
    title: variant.title,
    availableForSale: availabilityToAvailableForSale(variant.availability),
    price: money(variant.price, variant.currency || catalog.currency),
    compareAtPrice:
      variant.compare_price != null && variant.compare_price > variant.price
        ? money(variant.compare_price, variant.currency || catalog.currency)
        : null,
    image:
      image(variant.image, variant.title) ??
      image(product.images[0] ?? null, product.title),
    product: {title: product.title, handle: product.handle},
    selectedOptions: Object.entries(variant.options ?? {}).map(
      ([name, value]) => ({name, value}),
    ),
    cartAddUrl:
      variant.cart_add_url || cartAddUrl(catalog.add_url, [{sku: variant.sku}]),
    shipPromise: variant.ship_promise,
    availability: variant.availability,
    shopUrl: variant.url || product.url || null,
    discount: variant.discount
      ? {
          label: variant.discount.label,
          endsAt: variant.discount.ends_at,
          unitsLeft: variant.discount.units_left,
        }
      : null,
  };
}

/**
 * Pick the variant the URL asks for. `selectedOptions` comes straight
 * from the query string (`?Model=Gemini`), matched case-insensitively so
 * old links keep working; nothing matched falls back to the first
 * buyable variant, then the first variant.
 */
export function selectVariant(
  variants: ProductVariantFragment[],
  selectedOptions: Array<{name: string; value: string}>,
): ProductVariantFragment | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const wanted = selectedOptions.filter((o) => o.value);
  if (wanted.length) {
    const match = variants.find((v) =>
      wanted.every((w) =>
        v.selectedOptions.some(
          (o) => norm(o.name) === norm(w.name) && norm(o.value) === norm(w.value),
        ),
      ),
    );
    if (match) return match;
  }
  return variants.find((v) => v.availableForSale) ?? variants[0] ?? null;
}

/** Option axes in catalog order, each with the variants that carry them. */
function optionAxes(
  variants: ProductVariantFragment[],
): Array<{name: string; values: string[]}> {
  const axes = new Map<string, string[]>();
  for (const variant of variants) {
    for (const {name, value} of variant.selectedOptions) {
      const values = axes.get(name);
      if (!values) axes.set(name, [value]);
      else if (!values.includes(value)) values.push(value);
    }
  }
  return [...axes].map(([name, values]) => ({name, values}));
}

/** Map one catalog product onto the full product shape the PDP reads. */
export function toProduct(
  catalog: Catalog,
  product: CatalogProduct,
  selectedOptions: Array<{name: string; value: string}> = [],
): ProductFragment {
  const variants = product.variants.map((v) => mapVariant(catalog, product, v));
  const selected = selectVariant(variants, selectedOptions);
  const prices = variants.map((v) => Number(v.price.amount));
  const currency = variants[0]?.price.currencyCode ?? catalog.currency;
  const images = product.images.map((url, i) => image(url, product.title, i)!);
  return {
    id: `odoo:product:${product.handle}`,
    handle: product.handle,
    title: product.title,
    vendor: 'OpenDrone',
    productType: familyOf(product),
    description: product.description ?? '',
    descriptionHtml: product.description
      ? `<p>${escapeHtml(product.description)}</p>`
      : '',
    options: optionAxes(variants).map((axis) => ({
      name: axis.name,
      optionValues: axis.values.map((value) => ({
        name: value,
        firstSelectableVariant:
          variants.find(
            (v) =>
              v.availableForSale &&
              v.selectedOptions.some(
                (o) => o.name === axis.name && o.value === value,
              ),
          ) ??
          variants.find((v) =>
            v.selectedOptions.some(
              (o) => o.name === axis.name && o.value === value,
            ),
          ) ??
          null,
      })),
    })),
    selectedOrFirstAvailableVariant: selected,
    adjacentVariants: variants.filter((v) => v.id !== selected?.id),
    variants: {nodes: variants},
    images: {nodes: images},
    featuredImage: selected?.image ?? images[0] ?? null,
    priceRange: {
      minVariantPrice: money(prices.length ? Math.min(...prices) : 0, currency),
      maxVariantPrice: money(prices.length ? Math.max(...prices) : 0, currency),
    },
    seo: {title: null, description: product.description},
    rating:
      product.rating && product.rating.count > 0 ? product.rating : null,
    shopUrl: product.url,
    funding: product.funding ?? null,
  };
}

/** Map one catalog product onto the card shape listings and pods read. */
export function toCard(
  catalog: Catalog,
  product: CatalogProduct,
): ProductCardFragment {
  const full = toProduct(catalog, product);
  return {
    id: full.id,
    handle: full.handle,
    title: full.title,
    productType: full.productType,
    featuredImage: full.images.nodes[0] ?? full.featuredImage,
    priceRange: full.priceRange,
    variants: full.variants,
    funding: full.funding ?? null,
  };
}

/** Every product as a card, in catalog order. */
export function toCards(catalog: Catalog): ProductCardFragment[] {
  return catalog.products.map((p) => toCard(catalog, p));
}

/**
 * The selector model: every value of every axis with its selected /
 * available / exists flags and the query string that selects it. Local
 * replacement for Hydrogen's `getProductOptions`.
 */
export function mapProductOptions(
  product: ProductFragment,
): MappedProductOptions[] {
  const selected = product.selectedOrFirstAvailableVariant;
  const norm = (s: string) => s.trim().toLowerCase();
  return optionAxes(product.variants.nodes).map((axis) => ({
    name: axis.name,
    optionValues: axis.values.map((value) => {
      const variant =
        product.variants.nodes.find((v) =>
          v.selectedOptions.some(
            (o) => norm(o.name) === norm(axis.name) && norm(o.value) === norm(value),
          ),
        ) ?? null;
      const query = new URLSearchParams();
      for (const o of selected?.selectedOptions ?? []) {
        if (norm(o.name) !== norm(axis.name)) query.set(o.name, o.value);
      }
      query.set(axis.name, value);
      return {
        name: value,
        handle: product.handle,
        variantUriQuery: query.toString(),
        selected: Boolean(
          selected?.selectedOptions.some(
            (o) => norm(o.name) === norm(axis.name) && norm(o.value) === norm(value),
          ),
        ),
        available: Boolean(variant?.availableForSale),
        exists: Boolean(variant),
        isDifferentProduct: false,
        swatch: null,
        firstSelectableVariant: variant,
      };
    }),
  }));
}

/** Option values from the request URL, e.g. `?Model=Gemini`. */
export function selectedOptionsFromRequest(
  request: Request,
): Array<{name: string; value: string}> {
  const out: Array<{name: string; value: string}> = [];
  const url = new URL(request.url);
  for (const [name, value] of url.searchParams) {
    if (name.startsWith('_') || !value) continue;
    out.push({name, value});
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Locale-free money formatting, replacing Hydrogen's `<Money>`. */
export function formatPrice(
  amount: string | number | null | undefined,
  currencyCode: string | null | undefined,
): string {
  if (amount == null || amount === '') return '';
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return '';
  const currency = currencyCode || 'EUR';
  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
