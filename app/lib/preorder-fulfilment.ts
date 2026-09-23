/**
 * Hold paid preorder orders until their batch ships, and tag them by batch.
 *
 * A paid order with any line carrying the `Preorder` line attribute (the
 * ship promise the cart wrote, `PREORDER_ATTRIBUTE` in
 * `shopify-storefront.ts`) gets:
 *
 * - a fulfillment hold (reason OTHER, handle `opendrone-preorder`) on each
 *   open fulfillment order, with a note naming the batch and its promise, so
 *   the bpost plugin does not import it for a label before the batch exists;
 * - the order tag `preorder` and one tag per campaign SKU batch its units
 *   fall into, e.g. `batch:OPENFC-LITE-2020:1`.
 *
 * Batches follow the campaign count (`shopify-orders.ts`): counted orders in
 * creation order, each line's `currentQuantity` taking the next units of its
 * SKU. A line that runs over a batch boundary gets both batch tags. A SKU
 * that ships with another (`shipsWith` in `content/preorders.json`) takes
 * the lead SKU's batch tag: its pinned batch, or the batch the lead's next
 * unit fell into when the order was placed. It adds no units to the lead.
 *
 * Idempotent: the `preorder` tag marks an order as done, and a fulfillment
 * order that already carries the `opendrone-preorder` hold is not held
 * again. The hold is written before the tags, so a failed tag write is
 * retried on the next pass without a second hold. Once
 * `scripts/release-batch.mjs` releases a hold, the tag keeps this module
 * from holding the order again.
 *
 * The Admin token needs `read_orders`, `write_merchant_managed_fulfillment_orders`
 * and `write_orders` (for the tags).
 *
 * Kept free of worker APIs and path aliases so node:test and the scripts
 * (`node --experimental-strip-types`) can load it.
 */

import type {CampaignBatch, CampaignConfig, ShipsWith} from './preorder-campaign.ts';

const DEFAULT_ADMIN_API_VERSION = '2026-07';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const COUNTED_STATES = new Set(['PAID', 'PARTIALLY_REFUNDED']);
const HOLDABLE_STATES = new Set(['OPEN', 'ON_HOLD']);
const NOTE_LIMIT = 255;

/** Same key as `PREORDER_ATTRIBUTE` in `shopify-storefront.ts` (a test pins it). */
export const PREORDER_LINE_ATTRIBUTE = 'Preorder';
/** Order tag that marks an order as held and tagged by this module. */
export const PREORDER_TAG = 'preorder';
/** Hold handle: one per app per fulfillment order, so it doubles as the marker. */
export const PREORDER_HOLD_HANDLE = 'opendrone-preorder';

export type AdminEnv = Pick<
  Env,
  'SHOPIFY_STORE_DOMAIN' | 'SHOPIFY_ADMIN_API_TOKEN' | 'SHOPIFY_ADMIN_API_VERSION'
>;

export const PREORDER_ORDERS_QUERY = `#graphql
  query OpenDronePreorderOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        createdAt
        test
        cancelledAt
        displayFinancialStatus
        tags
        email
        customerLocale
        lineItems(first: 100) {
          pageInfo { hasNextPage }
          nodes { sku name currentQuantity customAttributes { key value } }
        }
        fulfillmentOrders(first: 10) {
          nodes { id status fulfillmentHolds { id handle reasonNotes } }
        }
      }
    }
  }
`;

export const HOLD_MUTATION = `#graphql
  mutation OpenDronePreorderHold($id: ID!, $fulfillmentHold: FulfillmentOrderHoldInput!) {
    fulfillmentOrderHold(id: $id, fulfillmentHold: $fulfillmentHold) {
      userErrors { field message }
    }
  }
`;

export const RELEASE_MUTATION = `#graphql
  mutation OpenDronePreorderRelease($id: ID!, $holdIds: [ID!]) {
    fulfillmentOrderReleaseHold(id: $id, holdIds: $holdIds) {
      fulfillmentOrder { id status }
      userErrors { field message }
    }
  }
`;

export const TAGS_ADD_MUTATION = `#graphql
  mutation OpenDronePreorderTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

export type PreorderOrder = {
  id: string;
  name: string;
  createdAt: string;
  test: boolean;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  tags: string[];
  email: string | null;
  customerLocale: string | null;
  lineItems: {
    pageInfo: {hasNextPage: boolean};
    nodes: Array<{
      sku: string | null;
      name: string;
      currentQuantity: number;
      customAttributes: Array<{key: string; value: string | null}>;
    }>;
  };
  fulfillmentOrders: {
    nodes: Array<{
      id: string;
      status: string;
      fulfillmentHolds: Array<{id: string; handle: string | null; reasonNotes: string | null}>;
    }>;
  };
};

/** One campaign batch an order line's units fall into. `sku` is the
 *  campaign SKU the batch belongs to; `item` is the line's own SKU when it
 *  ships with that one. */
export type LineBatch = {sku: string; batch: number; units: number; shipPromise: string; item?: string};

export type HoldPlan = {
  orderId: string;
  orderName: string;
  /** Tags to add, `preorder` first. */
  tags: string[];
  /** Fulfillment orders that still need the preorder hold. */
  hold: string[];
  note: string;
  batches: LineBatch[];
};

export type HoldSync = {
  planned: HoldPlan[];
  applied: boolean;
  /** Order name to what failed; the next pass retries it. */
  errors: Record<string, string>;
};

export function adminEndpoint(env: AdminEnv): {url: string; token: string} {
  const domain = env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  if (!domain || !token || !/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(domain)) {
    throw new Error('preorder fulfilment: Admin API is not configured');
  }
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || DEFAULT_ADMIN_API_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) {
    throw new Error('preorder fulfilment: invalid Admin API version');
  }
  return {url: `https://${domain}/admin/api/${version}/graphql.json`, token};
}

export async function adminGraphql<T>(
  env: AdminEnv,
  query: string,
  variables: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const {url, token} = adminEndpoint(env);
  const response = await fetcher(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
    body: JSON.stringify({query, variables}),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`preorder fulfilment: Admin API returned ${response.status}`);
  const body = (await response.json()) as {data?: T; errors?: Array<{message?: string}>};
  if (body.errors?.length) {
    throw new Error(`preorder fulfilment: ${String(body.errors[0]?.message ?? 'GraphQL error').slice(0, 200)}`);
  }
  if (!body.data) throw new Error('preorder fulfilment: no data');
  return body.data;
}

/** Every order created on or after `countFrom`, oldest first. */
export async function fetchPreorderOrders(
  env: AdminEnv,
  countFrom: string,
  fetcher: typeof fetch = fetch,
): Promise<PreorderOrder[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(countFrom)) {
    throw new Error('preorder fulfilment: countFrom must be YYYY-MM-DD');
  }
  const orders: PreorderOrder[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data: {
      orders: {pageInfo: {hasNextPage: boolean; endCursor: string | null}; nodes: PreorderOrder[]};
    } = await adminGraphql(
      env,
      PREORDER_ORDERS_QUERY,
      {first: PAGE_SIZE, after, query: `created_at:>=${countFrom}`},
      fetcher,
    );
    for (const order of data.orders.nodes) {
      if (order.lineItems.pageInfo.hasNextPage) {
        throw new Error(`preorder fulfilment: order ${order.name} has more than 100 lines`);
      }
      orders.push(order);
    }
    if (!data.orders.pageInfo.hasNextPage) return orders;
    after = data.orders.pageInfo.endCursor;
    if (!after) throw new Error('preorder fulfilment: pagination cursor is missing');
  }
  throw new Error('preorder fulfilment: more orders than the page limit');
}

/** Paid, not cancelled, not a test: the same orders the campaign counts. */
export function isCountedOrder(order: Pick<PreorderOrder, 'test' | 'cancelledAt' | 'displayFinancialStatus'>): boolean {
  return !order.test && !order.cancelledAt && COUNTED_STATES.has(order.displayFinancialStatus);
}

export function isPreorderOrder(order: PreorderOrder): boolean {
  return order.lineItems.nodes.some((line) =>
    line.customAttributes.some((a) => a.key === PREORDER_LINE_ATTRIBUTE && Boolean(a.value?.trim())),
  );
}

/** The 1-based batch that paid unit `unit` (1-based) of a SKU falls into.
 *  Past the last configured batch, batches repeat the last one's size. */
export function batchOfUnit(batches: CampaignBatch[], unit: number): {batch: number; entry: CampaignBatch} {
  let end = 0;
  for (let i = 0; ; i += 1) {
    const entry = i < batches.length ? batches[i] : {units: batches[batches.length - 1].units};
    end += entry.units;
    if (unit <= end) return {batch: i + 1, entry};
  }
}

export function batchTag(sku: string, batch: number): string {
  return `batch:${sku}:${batch}`;
}

/** Parse `batch:SKU:N`, or null. */
export function parseBatchTag(tag: string): {sku: string; batch: number} | null {
  const match = /^batch:([A-Za-z0-9-]+):(\d+)$/.exec(tag.trim());
  return match ? {sku: match[1], batch: Number(match[2])} : null;
}

/**
 * The campaign batches of every counted order, walking orders oldest first
 * so batch numbers agree with the campaign meter. Keyed by order id.
 */
export function assignBatches(
  orders: PreorderOrder[],
  config: CampaignConfig,
): Map<string, LineBatch[]> {
  const cumulative: Record<string, number> = {};
  const result = new Map<string, LineBatch[]>();
  const sorted = [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const order of sorted) {
    if (!isCountedOrder(order)) continue;
    const found: LineBatch[] = [];
    // The lead counts as the storefront showed them when the order was placed.
    const before = {...cumulative};
    for (const line of order.lineItems.nodes) {
      const sku = line.sku?.trim();
      const rule = sku ? config.shipsWith?.[sku] : undefined;
      if (sku && rule && config.skus[rule.sku] && line.currentQuantity > 0) {
        const lead = config.skus[rule.sku].batches;
        const batch = rule.batch ?? batchOfUnit(lead, (before[rule.sku] ?? 0) + 1).batch;
        const ships = lead[batch - 1]?.ships?.trim() || config.pendingShips;
        found.push({sku: rule.sku, batch, units: line.currentQuantity, shipPromise: ships, item: sku});
        continue;
      }
      const entry = sku ? config.skus[sku] : undefined;
      if (!sku || !entry || !(line.currentQuantity > 0)) continue;
      const start = cumulative[sku] ?? 0;
      for (let unit = start + 1; unit <= start + line.currentQuantity; unit += 1) {
        const {batch, entry: batchEntry} = batchOfUnit(entry.batches, unit);
        const existing = found.find((b) => b.sku === sku && b.batch === batch && !b.item);
        if (existing) existing.units += 1;
        else {
          found.push({sku, batch, units: 1, shipPromise: batchEntry.ships?.trim() || config.pendingShips});
        }
      }
      cumulative[sku] = start + line.currentQuantity;
    }
    result.set(order.id, found);
  }
  return result;
}

/** The hold note: which batch the order waits for, in plain words. */
export function holdNote(batches: LineBatch[]): string {
  const parts = batches.map(
    (b) => `${b.item ? `${b.item} with ` : ''}${b.sku} batch ${b.batch} (${b.shipPromise})`,
  );
  const text = parts.length
    ? `Preorder: hold until every batch ships. ${parts.join('; ')}.`
    : 'Preorder: hold until the preorder items ship.';
  return text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT - 3)}...` : text;
}

function hasPreorderHold(fo: PreorderOrder['fulfillmentOrders']['nodes'][number]): boolean {
  return fo.fulfillmentHolds.some((h) => h.handle === PREORDER_HOLD_HANDLE);
}

/**
 * What each paid preorder order still needs. An order already tagged
 * `preorder` is done, including after its hold was released.
 */
export function planPreorderHolds(orders: PreorderOrder[], config: CampaignConfig): HoldPlan[] {
  const batches = assignBatches(orders, config);
  const plans: HoldPlan[] = [];
  for (const order of orders) {
    if (!isCountedOrder(order) || !isPreorderOrder(order)) continue;
    if (order.tags.includes(PREORDER_TAG)) continue;
    const orderBatches = batches.get(order.id) ?? [];
    const hold = order.fulfillmentOrders.nodes
      .filter((fo) => HOLDABLE_STATES.has(fo.status) && !hasPreorderHold(fo))
      .map((fo) => fo.id);
    plans.push({
      orderId: order.id,
      orderName: order.name,
      tags: [PREORDER_TAG, ...new Set(orderBatches.map((b) => batchTag(b.sku, b.batch)))],
      hold,
      note: holdNote(orderBatches),
      batches: orderBatches,
    });
  }
  return plans;
}

type UserErrors = Array<{field?: string[] | null; message: string}>;

/**
 * Hold and tag every paid preorder order that is not yet done. `apply`
 * false only plans. One order's failure does not stop the others; it is
 * named in `errors` and retried on the next pass.
 */
export async function syncPreorderHolds(
  env: AdminEnv,
  config: CampaignConfig,
  {apply = false, fetcher = fetch}: {apply?: boolean; fetcher?: typeof fetch} = {},
): Promise<HoldSync> {
  const orders = await fetchPreorderOrders(env, config.countFrom, fetcher);
  const planned = planPreorderHolds(orders, config);
  const errors: Record<string, string> = {};
  if (!apply) return {planned, applied: false, errors};

  for (const plan of planned) {
    try {
      for (const id of plan.hold) {
        const data = await adminGraphql<{fulfillmentOrderHold: {userErrors: UserErrors}}>(
          env,
          HOLD_MUTATION,
          {
            id,
            fulfillmentHold: {
              reason: 'OTHER',
              reasonNotes: plan.note,
              handle: PREORDER_HOLD_HANDLE,
              notifyMerchant: false,
            },
          },
          fetcher,
        );
        const userErrors = data.fulfillmentOrderHold.userErrors;
        if (userErrors.length) throw new Error(`hold: ${userErrors[0].message}`);
      }
      const data = await adminGraphql<{tagsAdd: {userErrors: UserErrors}}>(
        env,
        TAGS_ADD_MUTATION,
        {id: plan.orderId, tags: plan.tags},
        fetcher,
      );
      const userErrors = data.tagsAdd.userErrors;
      if (userErrors.length) throw new Error(`tags: ${userErrors[0].message}`);
    } catch (error) {
      errors[plan.orderName] = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
  }
  return {planned, applied: true, errors};
}

/** The batches of an order read back from its tags, ignoring SKUs whose
 *  lines are gone (refunded or removed, `currentQuantity` 0). A live line
 *  of a SKU that ships with another keeps its lead's tags live. */
export function orderBatchesFromTags(
  order: PreorderOrder,
  shipsWith: Record<string, ShipsWith> = {},
): Array<{sku: string; batch: number}> {
  const live = new Set(
    order.lineItems.nodes
      .filter((l) => l.currentQuantity > 0 && l.sku)
      .map((l) => l.sku!.trim())
      .map((sku) => shipsWith[sku]?.sku ?? sku),
  );
  return order.tags
    .map(parseBatchTag)
    .filter((b): b is {sku: string; batch: number} => b !== null && live.has(b.sku));
}

export type ReleasePlan = {
  orderId: string;
  orderName: string;
  /** Fulfillment order id to the preorder hold ids on it. */
  release: Array<{id: string; holdIds: string[]}>;
  /** Other batches this order still waits for; empty when it can ship. */
  waitsFor: string[];
};

/**
 * Orders held for `sku` batch `batch`. An order ships as one parcel, so it
 * is released only when every batch it carries is `ready` (the requested
 * batch plus any the operator names as ready or settled).
 */
export function planRelease(
  orders: PreorderOrder[],
  sku: string,
  batch: number,
  ready: ReadonlySet<string>,
  shipsWith: Record<string, ShipsWith> = {},
): ReleasePlan[] {
  const covered = new Set([batchTag(sku, batch), ...ready]);
  const plans: ReleasePlan[] = [];
  for (const order of orders) {
    if (!isCountedOrder(order)) continue;
    if (!order.tags.includes(batchTag(sku, batch))) continue;
    const release = order.fulfillmentOrders.nodes
      .map((fo) => ({
        id: fo.id,
        holdIds: fo.fulfillmentHolds.filter((h) => h.handle === PREORDER_HOLD_HANDLE).map((h) => h.id),
      }))
      .filter((fo) => fo.holdIds.length > 0);
    if (!release.length) continue;
    const waitsFor = orderBatchesFromTags(order, shipsWith)
      .map((b) => batchTag(b.sku, b.batch))
      .filter((tag) => !covered.has(tag));
    plans.push({orderId: order.id, orderName: order.name, release, waitsFor});
  }
  return plans;
}
