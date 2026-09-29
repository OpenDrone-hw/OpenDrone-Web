/**
 * Read a signed-in customer's own Shopify data for /account: email, up to
 * five recent orders with preorder batch status, and newsletter consent.
 *
 * Shopify owns the customer record (migrations/0005_accounts.sql: "No email
 * or name: Shopify owns the customer record"). Nothing here is written to
 * SUPPORT_DB - every call reads live from the Admin API and the result is
 * used for one request only, never persisted.
 *
 * Reuses the Admin GraphQL client from preorder-fulfilment.ts: same token,
 * same already-granted scopes (README "Variables and secrets" /
 * "Admin API token scopes" list `read_customers` and `read_orders`
 * together, and the support flip README notes the same `read_customers`
 * scope for the customer metafield). Preorder status per order reads the
 * `batch:<sku>:<n>` order tags `syncPreorderHolds` (preorder-fulfilment.ts)
 * already writes; it does not recompute batch assignment itself. An order
 * ships once, as one parcel, when every item is ready, so its preorder
 * promise is the LATEST promise among its live lines' batches
 * (`orderPromise`), never the first or earliest.
 *
 * Any failure - no token configured, a network error, a GraphQL error, or
 * the customer not found - returns null so the caller falls back to the
 * plain Shopify account link instead of guessing at data.
 *
 * Kept free of worker APIs and path aliases so node:test
 * (`node --experimental-strip-types`) can load it directly.
 */
import {adminGraphql, parseBatchTag, type AdminEnv} from '../preorder-fulfilment.ts';
import {
  campaignDate,
  configSoldUnder,
  datedShipParts,
  promiseDeliveredBy,
  shortCampaignDate,
  type CampaignBatch,
  type CampaignConfig,
} from '../preorder-campaign.ts';

export type CustomerMarketingState = 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'NOT_SUBSCRIBED' | 'PENDING' | 'REDACTED';

export type AccountOrderLine = {
  sku: string | null;
  /** Product title without the variant. */
  name: string;
  /** Variant title ("5\" Freestyle", "30×30"); null for a single-variant product. */
  variant: string | null;
  quantity: number;
};

export type OrderMoney = {amount: string; currencyCode: string};

/** The ship promise an order waits for: the latest of its lines' batches. */
export type OrderPromise = {
  /** `target`: ships once a funding target is reached; `date`: a placed supplier order. */
  kind: 'target' | 'date';
  /** Sortable day, YYYY-MM-DD; "late" or no qualifier resolves to the month end. */
  day: string;
  /** "ships by 31 Mar 2027" or "ships early Nov 2026". */
  text: string;
  /** "30 Nov 2026" when the batch names a delivery date. */
  delivered: string | null;
};

export type AccountOrder = {
  id: string;
  /** Shopify order name, e.g. "#1042". */
  name: string;
  createdAt: string;
  /** Shopify's own hosted order status page; null when Shopify sent none. */
  statusPageUrl: string | null;
  /** Live (not fully refunded/removed) lines only. */
  lines: AccountOrderLine[];
  /** Order total after refunds, in the currency the buyer paid in. */
  total: OrderMoney | null;
  /** Admin `displayFulfillmentStatus`, e.g. "FULFILLED", "UNFULFILLED". */
  fulfillmentStatus: string | null;
  /** Admin `displayFinancialStatus`, e.g. "PAID", "REFUNDED". */
  financialStatus: string | null;
  cancelled: boolean;
  /** The order carries the `preorder` tag. */
  isPreorder: boolean;
  /** Latest promise of the order's live batches; null when not a preorder
   *  or no batch tag matches a still-live line. */
  promise: OrderPromise | null;
};

export type AccountShopifyData = {
  email: string | null;
  newsletter: CustomerMarketingState | null;
  /** Newest first, capped at 5 by the query itself. */
  orders: AccountOrder[];
};

const CUSTOMER_QUERY = `#graphql
  query OpenDroneAccountCustomer($id: ID!) {
    customer(id: $id) {
      id
      email
      emailMarketingConsent { marketingState }
      orders(first: 5, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          statusPageUrl
          tags
          cancelledAt
          displayFulfillmentStatus
          displayFinancialStatus
          currentTotalPriceSet { presentmentMoney { amount currencyCode } }
          lineItems(first: 20) {
            nodes { sku title variantTitle currentQuantity }
          }
        }
      }
    }
  }
`;

type RawLine = {sku: string | null; title: string; variantTitle: string | null; currentQuantity: number};
type RawOrder = {
  id: string;
  name: string;
  createdAt: string;
  statusPageUrl: string | null;
  tags: string[];
  cancelledAt: string | null;
  displayFulfillmentStatus: string | null;
  displayFinancialStatus: string | null;
  currentTotalPriceSet: {presentmentMoney: OrderMoney} | null;
  lineItems: {nodes: RawLine[]};
};
type CustomerResult = {
  customer: {
    id: string;
    email: string | null;
    emailMarketingConsent: {marketingState: CustomerMarketingState} | null;
    orders: {nodes: RawOrder[]};
  } | null;
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The promise one batch makes. A batch without `ships` is a funding target:
 * it ships by the campaign's one `shipsBy` date. A placed supplier order
 * names its month; "early" and "mid" sort to the 10th and 20th, "late" or
 * no qualifier to the month end. Unreadable text sorts as `shipsBy`, the
 * conservative (later) reading.
 */
export function batchPromiseOf(batch: CampaignBatch, config: Pick<CampaignConfig, 'shipsBy'>): OrderPromise {
  const targetText = `ships by ${shortCampaignDate(campaignDate(config.shipsBy)) ?? config.shipsBy}`;
  const target: OrderPromise = {kind: 'target', day: config.shipsBy, text: targetText, delivered: null};
  const ships = batch.ships?.trim();
  if (!ships) return target;
  const parts = datedShipParts(ships);
  const match = /\b(?:(early|mid|late)[- ])?([A-Za-z]+) (\d{4})\b/i.exec(ships);
  if (!parts || !match) return target;
  const month = new Date(`${match[2]} 1, 2000`).getMonth() + 1;
  if (!(month >= 1)) return target;
  const year = Number(match[3]);
  const qualifier = match[1]?.toLowerCase();
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dayOfMonth = qualifier === 'early' ? 10 : qualifier === 'mid' ? 20 : lastDay;
  const delivered =
    promiseDeliveredBy(ships) ?? (batch.deliveryBy ? shortCampaignDate(campaignDate(batch.deliveryBy)) : null);
  return {kind: 'date', day: `${year}-${pad(month)}-${pad(dayOfMonth)}`, text: `ships ${parts.when}`, delivered};
}

/**
 * The promise an order waits for. One order ships once, in one parcel, when
 * every item is ready, so this is the LATEST promise among the batch tags
 * that still match a live line (a shipsWith accessory counts through its
 * lead SKU). Null without a preorder tag or a matching live batch tag.
 */
export function orderPromise(
  order: Pick<RawOrder, 'tags' | 'lineItems'> & {createdAt?: string},
  campaign: CampaignConfig,
): OrderPromise | null {
  const config = configSoldUnder(campaign, order.createdAt);
  if (!order.tags.includes('preorder')) return null;
  const shipsWith = config.shipsWith ?? {};
  const live = new Set(
    order.lineItems.nodes
      .filter((l) => l.currentQuantity > 0 && l.sku)
      .map((l) => shipsWith[l.sku!]?.sku ?? l.sku!),
  );
  // A live line the campaign does not list ships with the `usStock` batch:
  // that one batch tag stays live for it (a US order).
  const usStock = config.usStock;
  const unlisted = order.lineItems.nodes.some(
    (l) => l.currentQuantity > 0 && l.sku && !config.skus[l.sku] && !shipsWith[l.sku],
  );
  let latest: OrderPromise | null = null;
  for (const tag of order.tags) {
    const b = parseBatchTag(tag);
    if (!b) continue;
    const viaUsStock = unlisted && usStock && b.sku === usStock.sku && b.batch === usStock.batch;
    if (!live.has(b.sku) && !viaUsStock) continue;
    const entry = config.skus[b.sku]?.batches[b.batch - 1];
    if (!entry) continue;
    const promise = batchPromiseOf(entry, config);
    if (!latest || promise.day > latest.day) latest = promise;
  }
  return latest;
}

/**
 * The signed-in customer's own email, orders and newsletter consent, read
 * live by their Shopify GID. Null on any failure; see module doc.
 */
export async function readCustomerAccount(
  env: AdminEnv,
  shopifyGid: string,
  config: CampaignConfig,
  fetcher: typeof fetch = fetch,
): Promise<AccountShopifyData | null> {
  try {
    const result = await adminGraphql<CustomerResult>(env, CUSTOMER_QUERY, {id: shopifyGid}, fetcher);
    const customer = result.customer;
    if (!customer) return null;
    return {
      email: customer.email,
      newsletter: customer.emailMarketingConsent?.marketingState ?? null,
      orders: customer.orders.nodes.map((o) => ({
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        statusPageUrl: o.statusPageUrl,
        lines: o.lineItems.nodes
          .filter((l) => l.currentQuantity > 0)
          .map((l) => ({
            sku: l.sku,
            name: l.title,
            variant: l.variantTitle && l.variantTitle !== 'Default Title' ? l.variantTitle : null,
            quantity: l.currentQuantity,
          })),
        total: o.currentTotalPriceSet?.presentmentMoney ?? null,
        fulfillmentStatus: o.displayFulfillmentStatus,
        financialStatus: o.displayFinancialStatus,
        cancelled: Boolean(o.cancelledAt),
        isPreorder: o.tags.includes('preorder'),
        promise: orderPromise(o, config),
      })),
    };
  } catch {
    return null;
  }
}
