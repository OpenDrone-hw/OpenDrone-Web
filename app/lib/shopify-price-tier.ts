/**
 * Write each preorder price step to Shopify.
 *
 * Shopify holds the money: the compare-at price is the retail price and the
 * price is what the next unit costs. `priceTiers` in `content/preorders.json`
 * says how that price steps as paid units come in (`preorder-campaign.ts`),
 * and this module makes Shopify agree with the step the paid count implies.
 * Past the last step a variant sells at retail with no compare-at price, so
 * the storefront stops showing a "then €X" line.
 *
 * Called from the Shopify `orders/paid` webhook and from the Worker's
 * scheduled handler, which catches a webhook Shopify never delivered. Both
 * run only when `SHOPIFY_PRICE_TIER_WRITE_ENABLED` is `1`; every other value
 * leaves Shopify alone, and `applyCampaign` then closes any SKU whose price
 * is under its step rather than sell under it.
 *
 * The Admin token needs `write_products` on top of the order scopes.
 */

import {tierPrice, tiersFor, type CampaignConfig} from './preorder-campaign.ts';

const DEFAULT_ADMIN_API_VERSION = '2026-07';

type TierEnv = Pick<
  Env,
  | 'SHOPIFY_STORE_DOMAIN'
  | 'SHOPIFY_ADMIN_API_TOKEN'
  | 'SHOPIFY_ADMIN_API_VERSION'
  | 'SHOPIFY_PRICE_TIER_WRITE_ENABLED'
>;

export const TIER_VARIANTS_QUERY = `#graphql
  query OpenDronePreorderVariants($first: Int!, $query: String!) {
    productVariants(first: $first, query: $query) {
      nodes { id sku price compareAtPrice product { id } }
    }
  }
`;

export const TIER_UPDATE_MUTATION = `#graphql
  mutation OpenDronePreorderPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

type Variant = {
  id: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  product: {id: string};
};

export type TierChange = {
  sku: string;
  from: number;
  to: number;
  /** Retail price kept as the compare-at price, null past the last step. */
  compareAt: number | null;
};

export type TierSync = {
  /** Variants written, or that would be written on a dry run. */
  changed: TierChange[];
  /** SKU to why it was left alone: no retail price, or not in Shopify. */
  skipped: Record<string, string>;
  applied: boolean;
};

export function priceTierWritesEnabled(env: TierEnv): boolean {
  return env.SHOPIFY_PRICE_TIER_WRITE_ENABLED === '1';
}

function adminEndpoint(env: TierEnv): {url: string; token: string} {
  const domain = env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  if (!domain || !token || !/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(domain)) {
    throw new Error('shopify price tier: Admin API is not configured');
  }
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || DEFAULT_ADMIN_API_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) {
    throw new Error('shopify price tier: invalid Admin API version');
  }
  return {url: `https://${domain}/admin/api/${version}/graphql.json`, token};
}

async function admin<T>(
  env: TierEnv,
  query: string,
  variables: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<T> {
  const {url, token} = adminEndpoint(env);
  const response = await fetcher(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
    body: JSON.stringify({query, variables}),
  });
  if (!response.ok) {
    throw new Error(`shopify price tier: HTTP ${response.status}`);
  }
  const body = (await response.json()) as {data?: T; errors?: Array<{message?: string}>};
  if (body.errors?.length) {
    throw new Error(`shopify price tier: ${body.errors[0]?.message ?? 'GraphQL error'}`);
  }
  if (!body.data) throw new Error('shopify price tier: no data');
  return body.data;
}

/** The step a SKU's next unit sells at: its price, and retail while a step
 *  is left. Past the last step, retail with no compare-at price. */
export function targetPrice(
  config: CampaignConfig,
  units: number,
  retail: number,
  sku?: string,
): {price: number; compareAt: number | null} {
  const tiers = sku ? tiersFor(config, sku) : config.priceTiers;
  const tier = tiers.find((t) => units < t.upTo);
  if (!tier) return {price: retail, compareAt: null};
  return {price: tierPrice(retail, tier.off) ?? retail, compareAt: retail};
}

const cents = (value: number) => Math.round(value * 100);

/**
 * Make Shopify agree with the step every campaign SKU's paid count implies.
 * `apply` false plans without writing. A variant with no retail price (no
 * compare-at price and already at or under its step) is skipped and named.
 */
export async function syncPriceTiers(
  env: TierEnv,
  config: CampaignConfig,
  units: Record<string, number>,
  {apply = false, fetcher = fetch}: {apply?: boolean; fetcher?: typeof fetch} = {},
): Promise<TierSync> {
  const skus = Object.keys(config.skus);
  if (!skus.length) return {changed: [], skipped: {}, applied: false};

  const data = await admin<{productVariants: {nodes: Variant[]}}>(
    env,
    TIER_VARIANTS_QUERY,
    {first: 250, query: skus.map((sku) => `sku:${sku}`).join(' OR ')},
    fetcher,
  );
  const live = new Map<string, Variant>();
  for (const node of data.productVariants.nodes) {
    if (node.sku && skus.includes(node.sku)) live.set(node.sku, node);
  }

  const changed: TierChange[] = [];
  const skipped: Record<string, string> = {};
  const byProduct = new Map<string, Array<{id: string; price: string; compareAtPrice: string | null}>>();

  for (const sku of skus) {
    const variant = live.get(sku);
    if (!variant) {
      skipped[sku] = 'not in Shopify';
      continue;
    }
    const price = Number(variant.price);
    const compareAt = variant.compareAtPrice == null ? null : Number(variant.compareAtPrice);
    // Retail is the compare-at price while a step is left. Once the last
    // step is written the compare-at price is gone and the price is retail.
    const retail = compareAt != null && compareAt > price ? compareAt : price;
    if (!Number.isFinite(retail) || retail <= 0) {
      skipped[sku] = 'no retail price in Shopify';
      continue;
    }
    const target = targetPrice(config, units[sku] ?? 0, retail, sku);
    const samePrice = cents(price) === cents(target.price);
    const sameCompare =
      target.compareAt == null ? compareAt == null : compareAt != null && cents(compareAt) === cents(target.compareAt);
    if (samePrice && sameCompare) continue;
    changed.push({sku, from: price, to: target.price, compareAt: target.compareAt});
    const list = byProduct.get(variant.product.id) ?? [];
    list.push({
      id: variant.id,
      price: target.price.toFixed(2),
      compareAtPrice: target.compareAt == null ? null : target.compareAt.toFixed(2),
    });
    byProduct.set(variant.product.id, list);
  }

  if (!apply || !changed.length) return {changed, skipped, applied: false};

  for (const [productId, variants] of byProduct) {
    const result = await admin<{
      productVariantsBulkUpdate: {userErrors: Array<{field: string[] | null; message: string}>};
    }>(env, TIER_UPDATE_MUTATION, {productId, variants}, fetcher);
    const errors = result.productVariantsBulkUpdate.userErrors;
    if (errors.length) {
      throw new Error(`shopify price tier: ${errors[0].message}`);
    }
  }
  return {changed, skipped, applied: true};
}
