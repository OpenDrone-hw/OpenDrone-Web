/**
 * The request-scoped catalog client: the Shopify Storefront catalog mapped
 * into the shapes in `app/lib/catalog.ts`.
 *
 * The pure half, including every type and mapper, is `app/lib/catalog.ts`;
 * the Storefront API adapter is `app/lib/shopify-storefront.ts`.
 */

import type {Catalog} from './catalog.ts';
import {fetchShopifyCatalog} from './shopify-storefront.ts';

export type CatalogClient = {
  /** The catalog, read from the Shopify Storefront API. */
  get: () => Promise<Catalog>;
};

export function createCatalogClient({env}: {env: Env}): CatalogClient {
  return {get: () => fetchShopifyCatalog(env)};
}
