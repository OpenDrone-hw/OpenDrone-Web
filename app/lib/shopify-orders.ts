/**
 * Paid preorder units per SKU, read from Shopify orders through the Admin
 * API. This is the count behind every campaign meter and ship promise
 * (`app/lib/preorder-campaign.ts`).
 *
 * Counted: non-test, non-cancelled orders created on or after the
 * campaign's `countFrom` day whose financial status is PAID or
 * PARTIALLY_REFUNDED, using each line's `currentQuantity` (which drops
 * removed and refunded units). Checkout must capture payment automatically,
 * or an order stays AUTHORIZED and never counts.
 *
 * The Admin token needs `read_orders`, and `read_all_orders` once a campaign
 * runs longer than 60 days: without it Shopify only returns the last 60
 * days of orders and the counts would fall.
 *
 * One fetch per isolate per minute, shared by concurrent requests. Any
 * failure throws; the caller closes campaign SKUs rather than guessing.
 */

const DEFAULT_ADMIN_API_VERSION = '2026-07';
const FRESH_MS = 60_000;
const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const COUNTED_STATES = new Set(['PAID', 'PARTIALLY_REFUNDED']);

export const PAID_ORDERS_QUERY = `#graphql
  query OpenDronePaidPreorders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        test
        cancelledAt
        displayFinancialStatus
        lineItems(first: 250) {
          pageInfo { hasNextPage }
          nodes { sku currentQuantity }
        }
      }
    }
  }
`;

type OrdersEnv = Pick<
  Env,
  'SHOPIFY_STORE_DOMAIN' | 'SHOPIFY_ADMIN_API_TOKEN' | 'SHOPIFY_ADMIN_API_VERSION'
>;

type OrdersPage = {
  orders: {
    pageInfo: {hasNextPage: boolean; endCursor: string | null};
    nodes: Array<{
      test: boolean;
      cancelledAt: string | null;
      displayFinancialStatus: string;
      lineItems: {
        pageInfo: {hasNextPage: boolean};
        nodes: Array<{sku: string | null; currentQuantity: number}>;
      };
    }>;
  };
};

const memo = new Map<string, {units: Record<string, number>; fetchedAt: number}>();
const inflight = new Map<string, Promise<Record<string, number>>>();

function adminEndpoint(env: OrdersEnv): {url: string; token: string} {
  const domain = env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  if (!domain || !token || !/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(domain)) {
    throw new Error('shopify orders: Admin API is not configured');
  }
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || DEFAULT_ADMIN_API_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) {
    throw new Error('shopify orders: invalid Admin API version');
  }
  return {url: `https://${domain}/admin/api/${version}/graphql.json`, token};
}

/** Sum paid units for `skus` across every counted order since `countFrom`. */
export async function fetchPaidUnits(
  env: OrdersEnv,
  countFrom: string,
  skus: ReadonlySet<string>,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, number>> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(countFrom)) {
    throw new Error('shopify orders: countFrom must be YYYY-MM-DD');
  }
  const {url, token} = adminEndpoint(env);
  const units: Record<string, number> = {};
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
      body: JSON.stringify({
        query: PAID_ORDERS_QUERY,
        variables: {first: PAGE_SIZE, after, query: `created_at:>=${countFrom} status:any`},
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`shopify orders: Admin API returned ${response.status}`);
    const result = (await response.json()) as {data?: OrdersPage; errors?: unknown[]};
    if (result.errors?.length || !result.data) {
      throw new Error('shopify orders: Admin API rejected the query');
    }
    for (const order of result.data.orders.nodes) {
      if (order.test || order.cancelledAt || !COUNTED_STATES.has(order.displayFinancialStatus)) {
        continue;
      }
      if (order.lineItems.pageInfo.hasNextPage) {
        throw new Error('shopify orders: an order exceeds 250 lines');
      }
      for (const line of order.lineItems.nodes) {
        const sku = line.sku?.trim();
        if (!sku || !skus.has(sku)) continue;
        if (!Number.isSafeInteger(line.currentQuantity) || line.currentQuantity < 0) {
          throw new Error('shopify orders: invalid line quantity');
        }
        units[sku] = (units[sku] ?? 0) + line.currentQuantity;
      }
    }
    if (!result.data.orders.pageInfo.hasNextPage) return units;
    after = result.data.orders.pageInfo.endCursor;
    if (!after) throw new Error('shopify orders: pagination cursor is missing');
  }
  throw new Error('shopify orders: more orders than the page limit');
}

/** {@link fetchPaidUnits}, memoized per isolate for a minute. */
export function paidUnits(
  env: OrdersEnv,
  countFrom: string,
  skus: ReadonlySet<string>,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const key = `${env.SHOPIFY_STORE_DOMAIN ?? ''}|${countFrom}|${[...skus].sort().join(',')}`;
  const cached = memo.get(key);
  if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return Promise.resolve(cached.units);
  const running = inflight.get(key);
  if (running) return running;
  const request = fetchPaidUnits(env, countFrom, skus, fetcher)
    .then((units) => {
      memo.set(key, {units, fetchedAt: Date.now()});
      return units;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/** Test seam: drop the per-isolate memory. */
export function resetPaidUnitsMemo(): void {
  memo.clear();
  inflight.clear();
}
