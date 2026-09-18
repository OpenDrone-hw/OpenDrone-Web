/**
 * The product shapes the storefront components consume.
 *
 * These used to be generated from the Shopify Storefront API schema
 * (`storefrontapi.generated.d.ts`). The data now comes from the Odoo
 * catalog feed (`app/lib/catalog.ts`), which maps onto exactly these
 * shapes, so the views did not have to change when the backend did.
 *
 * Hand-written and bundler-free on purpose: the node:test suites import
 * the mapper that produces them.
 */

export type MoneyV2 = {amount: string; currencyCode: string};

export type SelectedOption = {name: string; value: string};

export type ProductImage = {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
};

/** Odoo's per-variant availability word, straight from the catalog feed. */
export type CatalogAvailability = 'in_stock' | 'preorder' | 'sold_out';

/**
 * A funded pre-order's progress toward its unit target, straight from the
 * catalog feed. Lives here, beside the other catalog-derived shapes, so a
 * card can carry it; `app/lib/catalog.ts` re-exports it as the name the
 * rest of the app imports.
 */
export type CatalogFunding = {
  targetUnits: number;
  unitsFunded: number;
  pct: number;
  state: 'draft' | 'open' | 'funded' | 'missed' | 'cancelled';
  dateDeadline: string | null;
  /**
   * Schema 2 additions. Every one of them is optional and reads null when
   * the feed does not carry it, so a schema-1 catalog (and every object
   * built before these existed) stays a valid `CatalogFunding`. Nothing
   * here may become required: the storefront has to render a campaign
   * from `targetUnits`/`unitsFunded`/`state` alone.
   */
  /** ISO day the campaign opened, or null. */
  dateOpen?: string | null;
  /** Distinct backers on this campaign, or null when the feed omits it. */
  backers?: number | null;
  /** Money pledged so far, in `currency`, or null. */
  amountFunded?: number | null;
  /** ISO code for `amountFunded`, e.g. "EUR", or null. */
  currency?: string | null;
};

/**
 * A variant's promotional discount, straight from the catalog feed
 * (camelCase, mapped from the wire's snake_case by `mapVariant`). `endsAt`
 * and `unitsLeft` are carried for a future surface; only `label` is shown
 * today, next to the compare price.
 */
export type CatalogVariantDiscount = {
  label: string | null;
  endsAt: string | null;
  unitsLeft: number | null;
};

export type ProductVariantFragment = {
  id: string;
  sku: string | null;
  title: string;
  availableForSale: boolean;
  price: MoneyV2;
  compareAtPrice: MoneyV2 | null;
  image: ProductImage | null;
  product: {title: string; handle: string};
  selectedOptions: SelectedOption[];
  /** The shop's ready-made single-line hand-off link for this SKU. */
  cartAddUrl: string;
  /** Odoo's ship promise, shown where the local statusNote is shown. */
  shipPromise: string | null;
  availability: CatalogAvailability;
  /** The variant's page on the shop, for the review list link. */
  shopUrl: string | null;
  /** Promotional discount on this variant, or null for an ordinary price. */
  discount: CatalogVariantDiscount | null;
};

/** Card-sized product: listings, related strip, header pods, hero. */
export type ProductCardFragment = {
  id: string;
  handle: string;
  title: string;
  productType: string | null;
  featuredImage: ProductImage | null;
  priceRange: {minVariantPrice: MoneyV2; maxVariantPrice: MoneyV2};
  variants: {nodes: ProductVariantFragment[]};
  /** Funded pre-order progress, null for an ordinary product. Reporting
   *  only: availability still decides what can be bought. */
  funding?: CatalogFunding | null;
};

/** One option axis with its values, as the pill grid and ladder read it. */
export type ProductOptionFragment = {
  name: string;
  optionValues: Array<{
    name: string;
    firstSelectableVariant: ProductVariantFragment | null;
  }>;
};

export type ProductFragment = ProductCardFragment & {
  vendor: string;
  description: string;
  descriptionHtml: string;
  options: ProductOptionFragment[];
  selectedOrFirstAvailableVariant: ProductVariantFragment | null;
  adjacentVariants: ProductVariantFragment[];
  images: {nodes: ProductImage[]};
  seo: {title: string | null; description: string | null};
  /** Published aggregate rating from Odoo, null when nobody rated yet. */
  rating: {average: number; count: number} | null;
  /** The product page on the shop, where reviews are read and written. */
  shopUrl: string;
};

/**
 * The resolved option model the selectors render: every value of every
 * axis, whether it exists, whether it is buyable, and the query string
 * that selects it. Local replacement for Hydrogen's `getProductOptions`.
 */
export type MappedProductOptions = {
  name: string;
  optionValues: Array<{
    name: string;
    handle: string;
    variantUriQuery: string;
    selected: boolean;
    available: boolean;
    exists: boolean;
    isDifferentProduct: boolean;
    swatch: null;
    firstSelectableVariant: ProductVariantFragment | null;
  }>;
};

/** One line of a hand-off link: a SKU and how many of it. */
export type CartLine = {sku: string; quantity?: number};
