import type {Catalog} from './catalog.ts';

const API_VERSION = '2026-07';
const CAMPAIGN_START = '2026-09-20T00:00:00Z';
const PAID_STATES = new Set(['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED']);

export const CAMPAIGN_TARGETS: Readonly<Record<string, number>> = {
  'OPENESC-2020': 1000,
  'OPENESC-3030': 1000,
  'OPENFC-LITE-2020': 1000,
  'OPENFC-LITE-3030': 1000,
  'OPENFRAME-3': 1000,
  'OPENFRAME-5': 1000,
  'OPENRX-LITE': 1000,
  'OPENRX-LITE-UFL': 1000,
  'OPENRX-MONO': 1000,
  'OPENRX-GEMINI': 1000,
  'OPENMOTOR-1604': 4000,
  'OPENMOTOR-2207': 4000,
};

export const CAMPAIGN_ORDERS_QUERY = `#graphql
  query OpenDroneCampaignOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        cancelledAt
        displayFinancialStatus
        customAttributes { key value }
        lineItems(first: 250) {
          pageInfo { hasNextPage }
          nodes { sku currentQuantity }
        }
      }
    }
  }
`;

type CampaignSnapshot = {unitsBySku: Record<string, number>; updatedAt: string};
type CampaignEnv = Pick<Env, 'SHOPIFY_STORE_DOMAIN' | 'SHOPIFY_ADMIN_API_TOKEN' | 'SHOPIFY_ADMIN_API_VERSION'>;
let memo: {snapshot: CampaignSnapshot; fetchedAt: number} | undefined;

export async function fetchShopifyCampaignProgress(
  env: CampaignEnv,
  fetcher: typeof fetch = fetch,
): Promise<CampaignSnapshot> {
  if (memo && Date.now() - memo.fetchedAt < 60_000) return memo.snapshot;
  const domain = env.SHOPIFY_STORE_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || API_VERSION;
  if (!domain || !token || !/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/i.test(domain)) {
    throw new Error('shopify campaign: Admin API is not configured');
  }
  const unitsBySku: Record<string, number> = {};
  let after: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const response = await fetcher(`https://${domain}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
      body: JSON.stringify({
        query: CAMPAIGN_ORDERS_QUERY,
        variables: {first: 250, after, query: `created_at:>=${CAMPAIGN_START} status:any`},
      }),
      redirect: 'manual',
    });
    if (!response.ok) throw new Error(`shopify campaign: Admin API returned ${response.status}`);
    const result = await response.json() as {data?: {orders: {pageInfo: {hasNextPage: boolean; endCursor: string | null}; nodes: Array<{cancelledAt: string | null; displayFinancialStatus: string; customAttributes: Array<{key: string; value: string}>; lineItems: {pageInfo: {hasNextPage: boolean}; nodes: Array<{sku: string | null; currentQuantity: number}>}}>;}}; errors?: unknown[]};
    if (result.errors?.length || !result.data) throw new Error('shopify campaign: Admin API rejected the query');
    for (const order of result.data.orders.nodes) {
      const preorder = order.customAttributes.some(
        ({key, value}) => key === 'OpenDrone order type' && value === 'Pre-order',
      );
      if (!preorder || order.cancelledAt || !PAID_STATES.has(order.displayFinancialStatus)) continue;
      if (order.lineItems.pageInfo.hasNextPage) throw new Error('shopify campaign: an order exceeds 250 lines');
      for (const line of order.lineItems.nodes) {
        const sku = line.sku?.trim();
        if (!sku || !(sku in CAMPAIGN_TARGETS) || !Number.isSafeInteger(line.currentQuantity) || line.currentQuantity < 0) continue;
        unitsBySku[sku] = (unitsBySku[sku] ?? 0) + line.currentQuantity;
      }
    }
    if (!result.data.orders.pageInfo.hasNextPage) break;
    after = result.data.orders.pageInfo.endCursor;
    if (!after) throw new Error('shopify campaign: pagination cursor is missing');
  }
  const snapshot = {unitsBySku, updatedAt: new Date().toISOString()};
  memo = {snapshot, fetchedAt: Date.now()};
  return snapshot;
}

export function applyCampaignProgress(catalog: Catalog, snapshot: CampaignSnapshot): Catalog {
  return {
    ...catalog,
    products: catalog.products.map((product) => {
      const variants = product.variants.map((variant) => ({
        ...variant,
        campaign_target: CAMPAIGN_TARGETS[variant.sku] ?? null,
        campaign_units_funded: snapshot.unitsBySku[variant.sku] ?? 0,
      }));
      const tracked = variants.filter((variant) => variant.campaign_target != null);
      if (!tracked.length) return {...product, variants};
      const targetUnits = tracked.reduce((sum, variant) => sum + (variant.campaign_target ?? 0), 0);
      const unitsFunded = tracked.reduce((sum, variant) => sum + variant.campaign_units_funded, 0);
      const funded = tracked.every((variant) => variant.campaign_units_funded >= (variant.campaign_target ?? Infinity));
      return {
        ...product,
        variants,
        funding: {
          targetUnits,
          unitsFunded,
          pct: Math.min(100, (unitsFunded / targetUnits) * 100),
          state: funded ? 'funded' as const : 'open' as const,
          dateDeadline: null,
        },
      };
    }),
  };
}

export function resetCampaignProgressMemo() { memo = undefined; }
