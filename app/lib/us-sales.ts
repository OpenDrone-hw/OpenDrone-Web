/**
 * US consumer preorders: the `PUBLIC_US_SALES` gate plus the flat US
 * shipping rate in `content/us-sales.json`. Both must be set for the US to
 * be sold direct; a missing rate keeps it closed (fail closed). Vite and
 * node:test read the same data.
 */

import type {Catalog, CatalogVariant} from './catalog.ts';

export type UsSalesFile = {rate?: number | null};

function loadUsSales(): UsSalesFile {
  if (import.meta.env) {
    const files = import.meta.glob<{default: UsSalesFile}>('/content/us-sales.json', {eager: true});
    return Object.values(files)[0]?.default ?? {};
  }
  // node:test: no bundler, read the same file.
  const fs = (
    globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}}
  ).process?.getBuiltinModule?.('node:fs') as {readFileSync: (url: URL, encoding: string) => string} | undefined;
  return fs ? (JSON.parse(fs.readFileSync(new URL('../../content/us-sales.json', import.meta.url), 'utf8')) as UsSalesFile) : {};
}

/** The US sales settings as committed. */
export const US_SALES: UsSalesFile = loadUsSales();

/**
 * The flat US shipping rate in USD when US consumer sales are open, else
 * null: the gate `PUBLIC_US_SALES` is exactly "1" and the committed rate is
 * a finite, non-negative number. Every US decision (quote, cart, catalog,
 * copy) reads this one answer.
 */
export function usSalesRate(
  env: {PUBLIC_US_SALES?: string} | null | undefined,
  file: UsSalesFile = US_SALES,
): number | null {
  if (env?.PUBLIC_US_SALES !== '1') return null;
  const rate = file.rate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : null;
}

/**
 * The campaign-aware catalog (EUR, campaign applied for the US region)
 * with Shopify's US market prices laid over it: each variant's price,
 * compare-at price and currency from `market` (the `@inContext(country: US)`
 * read, USD, no EU VAT). The price-step check already ran on the EUR
 * catalog. A campaign's step prices scale with the variant's US/EUR ratio.
 *
 * Fail closed: without a market read, and for a variant the US market does
 * not price in USD or does not sell, the variant is sold out.
 */
export function withMarketPrices(catalog: Catalog, market: Catalog | null): Catalog {
  const priced = new Map<string, CatalogVariant>();
  for (const product of market?.products ?? []) {
    for (const variant of product.variants) priced.set(variant.sku, variant);
  }
  const closed = (variant: CatalogVariant): CatalogVariant => ({
    ...variant,
    availability: 'sold_out',
    ship_promise: null,
    campaign: null,
  });
  const cents = (n: number) => Math.round(n * 100) / 100;
  return {
    ...catalog,
    currency: 'USD',
    prices_include_vat: false,
    products: catalog.products.map((product) => ({
      ...product,
      variants: product.variants.map((variant): CatalogVariant => {
        const us = priced.get(variant.sku);
        if (!us || us.currency !== 'USD' || us.availability === 'sold_out') return closed(variant);
        const scale =
          variant.compare_price && us.compare_price
            ? us.compare_price / variant.compare_price
            : variant.price > 0
              ? us.price / variant.price
              : 1;
        const campaign = variant.campaign
          ? {
              ...variant.campaign,
              price: variant.campaign.price == null ? null : cents(variant.campaign.price * scale),
              nextPrice: variant.campaign.nextPrice == null ? null : cents(variant.campaign.nextPrice * scale),
            }
          : variant.campaign;
        return {
          ...variant,
          price: us.price,
          compare_price: us.compare_price,
          currency: 'USD',
          ...(campaign !== undefined ? {campaign} : {}),
        };
      }),
    })),
  };
}
