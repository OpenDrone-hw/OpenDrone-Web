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

import {withoutBuyNow, type Catalog} from './catalog.ts';
import {resolveRegion} from './region.ts';
import {fetchShopifyCatalog} from './shopify-storefront.ts';
import {REPLAN_REUSE_MS, memoCatalog, readAndRemember, recentCatalog} from './catalog-memo.ts';
import {appCommerceEnabled} from './commerce/app-api.ts';
import {appCatalogClient} from './commerce/app-catalog.ts';
import {
  applyCampaign,
  campaignSkus,
  needsCampaignCounts,
  countedSkus,
  internationalRegion,
  isInternationalRegion,
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

export type CatalogReader = {
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

/** Page reads go through a short per-isolate cache of the Shopify catalog;
 *  `fresh` reads Shopify every time, for the cart and checkout paths, which
 *  must judge prices and batches on the live catalog. */
/** `recent` reuses a Shopify read no older than REPLAN_REUSE_MS (the cart
 *  loader right after a Ship to switch, cart-replan.ts), else reads fresh. */
export type CatalogClient = CatalogReader & {fresh: CatalogReader; recent: CatalogReader};

/** The allocation region for a destination with consumer checkout. */
export function buyerRegion(request: Request | undefined, env: Pick<Env, 'PUBLIC_US_SALES'>): Region {
  if (!request) return 'EU';
  const quote = shippingQuote(shipCountryForRequest(request), undefined, usSalesRate(env));
  return isUsQuote(quote) ? 'US' : isInternationalQuote(quote) ? internationalRegion(quote?.country) : 'EU';
}

async function withCampaign(env: Env, catalog: Catalog, region: Region): Promise<Catalog> {
  // A closed store has no campaign preorder variant and never calls the
  // Admin API. Its campaign SKUs still never show a compare-at price.
  if (!needsCampaignCounts(catalog, CAMPAIGN, region)) return {...catalog, campaign_skus: campaignSkus(CAMPAIGN)};
  const units = await paidUnitRuns(env, CAMPAIGN.countFrom, CAMPAIGN_SKUS, fetch, Date.now, CAMPAIGN).catch(
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
  if (appCommerceEnabled(env)) return appCatalogClient(env);
  const cached = catalogReader(env, request, (market = 'default') =>
    memoCatalog(market, () =>
      market === 'default' ? fetchShopifyCatalog(env) : fetchShopifyCatalog(env, fetch, market),
    ),
  );
  const read = (market = 'default') =>
    market === 'default' ? fetchShopifyCatalog(env) : fetchShopifyCatalog(env, fetch, market);
  // A fresh read is kept in the memo too, so the cart loader right after a
  // Ship to switch can reuse it (`recent`).
  const fresh = catalogReader(env, request, (market = 'default') => readAndRemember(market, () => read(market)));
  const recent = catalogReader(env, request, (market = 'default') => recentCatalog(market, REPLAN_REUSE_MS, () => read(market)));
  return {...cached, fresh, recent};
}

function catalogReader(
  env: Env,
  request: Request | undefined,
  load: (market?: string) => Promise<Catalog>,
): CatalogReader {
  const region = buyerRegion(request, env);
  const country = request ? shipCountryForRequest(request) ?? undefined : undefined;
  const get = async () => withCampaign(env, await load('default'), 'EU');
  const forRegion = async (target: Region, destination = country): Promise<Catalog> => {
    if (target === 'EU') return get();
    if (isInternationalRegion(target) && !destination) throw new Error('catalog: international destination missing');
    const [catalog, market] = await Promise.all([
      load('default'),
      load(target === 'US' ? 'US' : destination!).catch((error: unknown) => {
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
  // The Buy now lane only where the visitor's region has it (region.ts
  // `lanes.buyNow`): an EU country, never an unknown one. Without a request
  // (sitemap, feeds) the catalog is the EU one, unchanged.
  const buyNowLane = request ? resolveRegion(request, usSalesRate(env) != null).lanes.buyNow : true;
  return {get, region, forRegion, forBuyer: async () => {
    const catalog = await forRegion(region);
    return buyNowLane ? catalog : withoutBuyNow(catalog);
  }};
}
