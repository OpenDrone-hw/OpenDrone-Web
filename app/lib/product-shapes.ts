/**
 * The product shapes the storefront components consume.
 *
 * These used to be generated from the Shopify Storefront API schema
 * (`storefrontapi.generated.d.ts`). The catalog mapper
 * (`app/lib/catalog.ts`) produces exactly these shapes from the Shopify
 * adapter's output.
 *
 * Hand-written and bundler-free on purpose: the node:test suites import
 * the mapper that produces them.
 */

import type {CampaignState} from './preorder-campaign.ts';

export type MoneyV2 = {amount: string; currencyCode: string};

export type SelectedOption = {name: string; value: string};

export type ProductImage = {
  id: string;
  url: string;
  altText: string | null;
  width: number | null;
  height: number | null;
};

/** The per-variant availability word: the SKU's sale policy, denied by Shopify's availableForSale. */
export type CatalogAvailability = 'in_stock' | 'preorder' | 'sold_out';

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
  /** The catalog ship promise, shown where the local statusNote is shown. */
  shipPromise: string | null;
  /** Preorder campaign state for a campaign SKU, else null. */
  campaign: CampaignState | null;
  /** A campaign SKU's price once its preorder price ends, else null. */
  priceAfter: MoneyV2 | null;
  availability: CatalogAvailability;
  /** The variant's page on the shop, for the review list link. */
  shopUrl: string | null;
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
  /** Published aggregate rating, null when there is none. */
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
