/**
 * The request-scoped catalog client: the Shopify Storefront catalog mapped
 * into the shapes in `app/lib/catalog.ts`, with the preorder campaign
 * (`content/preorders.json`) applied from paid Shopify orders.
 *
 * The pure half, including every type and mapper, is `app/lib/catalog.ts`;
 * the Storefront API adapter is `app/lib/shopify-storefront.ts`.
 */

import type {Catalog} from './catalog.ts';
import {fetchShopifyCatalog} from './shopify-storefront.ts';
import {
  applyCampaign,
  needsCampaignCounts,
  parseCampaignConfig,
} from './preorder-campaign.ts';
import {paidUnits} from './shopify-orders.ts';
import preorders from '../../content/preorders.json';

export const CAMPAIGN = parseCampaignConfig(preorders);
const CAMPAIGN_SKUS = new Set(Object.keys(CAMPAIGN.skus));

export type CatalogClient = {
  /** The catalog, read from the Shopify Storefront API. */
  get: () => Promise<Catalog>;
};

export function createCatalogClient({env}: {env: Env}): CatalogClient {
  return {
    get: async () => {
      const catalog = await fetchShopifyCatalog(env);
      // A closed store has no campaign preorder variant and never calls the
      // Admin API.
      if (!needsCampaignCounts(catalog, CAMPAIGN)) return catalog;
      const units = await paidUnits(env, CAMPAIGN.countFrom, CAMPAIGN_SKUS).catch(
        (error: unknown) => {
          console.error(
            '[preorders] paid counts unavailable, closing campaign SKUs',
            error instanceof Error ? error.message : error,
          );
          return null;
        },
      );
      return applyCampaign(catalog, CAMPAIGN, units);
    },
  };
}
