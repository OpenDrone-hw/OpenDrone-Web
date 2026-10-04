import type {Catalog, CatalogVariant} from './catalog.ts';

/** Apply Shopify's selected-country prices after the EUR campaign price check. */
export function withInternationalPrices(catalog: Catalog, market: Catalog | null): Catalog {
  const prices = new Map<string, CatalogVariant>();
  for (const product of market?.products ?? []) {
    for (const variant of product.variants) prices.set(variant.sku, variant);
  }
  const closed = (variant: CatalogVariant): CatalogVariant => ({
    ...variant, availability: 'sold_out', ship_promise: null, campaign: null,
  });
  return {
    ...catalog,
    currency: market?.currency ?? catalog.currency,
    prices_include_vat: false,
    products: catalog.products.map((product) => ({
      ...product,
      variants: product.variants.map((variant): CatalogVariant => {
        const price = prices.get(variant.sku);
        if (!price || price.currency !== market?.currency) return closed(variant);
        const values = {price: price.price, compare_price: price.compare_price, currency: price.currency};
        if (price.availability === 'sold_out') return {...closed(variant), ...values};
        return {
          ...variant, ...values,
          ...(variant.campaign ? {campaign: {...variant.campaign, price: price.price, nextPrice: null, usLadder: undefined, internationalPrice: true}} : {}),
        };
      }),
    })),
  };
}
