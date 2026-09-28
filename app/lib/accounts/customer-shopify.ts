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
 * already writes; it does not recompute batch assignment itself, and the
 * ship-promise text reuses `shortShipPromise` (product-content.ts), the
 * same short-form the cart and PDP already show.
 *
 * Any failure - no token configured, a network error, a GraphQL error, or
 * the customer not found - returns null so the caller falls back to the
 * plain Shopify account link instead of guessing at data.
 *
 * Kept free of worker APIs and path aliases so node:test
 * (`node --experimental-strip-types`) can load it directly.
 */
import {adminGraphql, parseBatchTag, type AdminEnv} from '../preorder-fulfilment.ts';
import type {CampaignConfig} from '../preorder-campaign.ts';
import {shortShipPromise} from '../product-content.ts';

export type CustomerMarketingState = 'SUBSCRIBED' | 'UNSUBSCRIBED' | 'NOT_SUBSCRIBED' | 'PENDING' | 'REDACTED';

export type AccountOrderLine = {sku: string | null; name: string; quantity: number};

export type AccountOrder = {
  id: string;
  /** Shopify order name, e.g. "#1042". */
  name: string;
  createdAt: string;
  /** Shopify's own hosted order status page; null when Shopify sent none. */
  statusPageUrl: string | null;
  /** Live (not fully refunded/removed) lines only. */
  lines: AccountOrderLine[];
  /** "Preorder: ships by 14 March 2027 if reached", or "Preorder" with no
   *  matched batch tag, or null when the order carries no `preorder` tag. */
  preorderLabel: string | null;
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
          lineItems(first: 20) {
            nodes { sku name currentQuantity }
          }
        }
      }
    }
  }
`;

type RawLine = {sku: string | null; name: string; currentQuantity: number};
type RawOrder = {
  id: string;
  name: string;
  createdAt: string;
  statusPageUrl: string | null;
  tags: string[];
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

/**
 * The preorder label for one order: null without a `preorder` tag; the
 * short ship-promise text of the first live line's matched batch tag;
 * "Preorder" alone when the order is tagged but no batch tag matches a
 * still-live line (e.g. every preorder line was refunded).
 */
export function orderPreorderLabel(order: Pick<RawOrder, 'tags' | 'lineItems'>, config: CampaignConfig): string | null {
  if (!order.tags.includes('preorder')) return null;
  const shipsWith = config.shipsWith ?? {};
  const live = new Set(
    order.lineItems.nodes
      .filter((l) => l.currentQuantity > 0 && l.sku)
      .map((l) => shipsWith[l.sku!]?.sku ?? l.sku!),
  );
  const batch = order.tags
    .map(parseBatchTag)
    .find((b): b is {sku: string; batch: number} => b !== null && live.has(b.sku));
  if (!batch) return 'Preorder';
  const entry = config.skus[batch.sku]?.batches[batch.batch - 1];
  if (!entry) return 'Preorder';
  const promise = entry.ships?.trim() || config.pendingShips;
  const short = shortShipPromise(promise);
  return short ? `Preorder: ${short.text}` : 'Preorder';
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
          .map((l) => ({sku: l.sku, name: l.name, quantity: l.currentQuantity})),
        preorderLabel: orderPreorderLabel(o, config),
      })),
    };
  } catch {
    return null;
  }
}
