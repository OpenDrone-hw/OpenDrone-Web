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
 * An issued Declaration of Conformity for one SKU's current design
 * revision, straight from the catalog feed's optional `compliance` object
 * (`erp/docs/storefront-contract.md` section 2, PLAN.md 11.4). Present on
 * a variant only once `incutec_compliance` has an issued record for it;
 * absent otherwise, never a stand-in with empty fields.
 */
export type CatalogCompliance = {
  declaration_id: string | null;
  version: string | null;
  /** ISO date, e.g. "2026-09-14". */
  issued_on: string | null;
  doc_url: string;
  bundle_url: string;
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
  /** The issued DoC for this SKU, or null when none is issued yet. */
  compliance: CatalogCompliance | null;
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
