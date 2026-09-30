/**
 * The request-scoped catalog client: the Shopify Storefront catalog mapped
 * into the shapes in `app/lib/catalog.ts`, with the preorder campaign
 * (`content/preorders.json`) applied from paid Shopify orders.
 *
 * `get` is the catalog as an EU buyer sees it (EUR, EU batches): the
 * sitemap and surfaces without a purchase hand-off. `forBuyer` is the
 * catalog for this request's destination, with its allocation region and
 * Shopify country-context prices. EU uses the base EUR catalog, US keeps
 * its USD price ladder, and INT copies the selected country's live prices.
 *
 * The pure half, including every type and mapper, is `app/lib/catalog.ts`;
 * the Storefront API adapter is `app/lib/shopify-storefront.ts`.
 */

import type {Catalog} from './catalog.ts';
import {fetchShopifyCatalog} from './shopify-storefront.ts';
import {
  applyCampaign,
  needsCampaignCounts,
  countedSkus,
  parseCampaignConfig,
  type Region,
} from './preorder-campaign.ts';
import {paidUnitRuns} from './shopify-orders.ts';
import {isInternationalQuote, isUsQuote, shipCountryForRequest, shippingQuote} from './shipping-rates.ts';
import {withInternationalPrices} from './international-prices.ts';
import {usSalesRate, withMarketPrices} from './us-sales.ts';
import preorders from '../../content/preorders.json';

export const CAMPAIGN = parseCampaignConfig(preorders);
const CAMPAIGN_SKUS = countedSkus(CAMPAIGN);

export type CatalogClient = {
  /** The catalog, read from the Shopify Storefront API, as an EU buyer
   *  sees it. */
  get: () => Promise<Catalog>;
  /** The catalog for this request's destination: `get` for every
   *  EU destination. Non-EU destinations use their own allocation and prices. */
  forBuyer: () => Promise<Catalog>;
  /** The catalog for one region, whatever this request's destination is:
   *  the cart country switch prices a cart for the country just picked. */
  forRegion: (region: Region, country?: string) => Promise<Catalog>;
  /** The region `forBuyer` serves. */
  region: Region;
};

/** The allocation region for a destination with consumer checkout. */
export function buyerRegion(request: Request | undefined, env: Pick<Env, 'PUBLIC_US_SALES'>): Region {
  if (!request) return 'EU';
  const quote = shippingQuote(shipCountryForRequest(request), undefined, usSalesRate(env));
  return isUsQuote(quote) ? 'US' : isInternationalQuote(quote) ? 'INT' : 'EU';
}

async function withCampaign(env: Env, catalog: Catalog, region: Region): Promise<Catalog> {
  // A closed store has no campaign preorder variant and never calls the
  // Admin API.
  if (!needsCampaignCounts(catalog, CAMPAIGN, region)) return catalog;
  const units = await paidUnitRuns(env, CAMPAIGN.countFrom, CAMPAIGN_SKUS).catch(
    (error: unknown) => {
      console.error(
        '[preorders] paid counts unavailable, closing campaign SKUs',
        error instanceof Error ? error.message : error,
      );
      return null;
    },
  );
  return applyCampaign(catalog, CAMPAIGN, units, new Date(), region);
}

export function createCatalogClient({env, request}: {env: Env; request?: Request}): CatalogClient {
  const region = buyerRegion(request, env);
  const country = request ? shipCountryForRequest(request) ?? undefined : undefined;
  const get = async () => withCampaign(env, await fetchShopifyCatalog(env), 'EU');
  const forRegion = async (target: Region, destination = country): Promise<Catalog> => {
    if (target === 'EU') return get();
    if (target === 'INT' && !destination) throw new Error('catalog: international destination missing');
    const [catalog, market] = await Promise.all([
      fetchShopifyCatalog(env),
      fetchShopifyCatalog(env, fetch, target === 'US' ? 'US' : destination!).catch((error: unknown) => {
        console.error(
          '[catalog] destination market prices unavailable, closing destination sales',
          error instanceof Error ? error.message : error,
        );
        return null;
      }),
    ]);
    const campaign = await withCampaign(env, catalog, target);
    return target === 'US' ? withMarketPrices(campaign, market, CAMPAIGN) : withInternationalPrices(campaign, market);
  };
  return {get, region, forRegion, forBuyer: () => forRegion(region)};
}
