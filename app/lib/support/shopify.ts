/**
 * Shopify is the CRM: a ticket is linked to the Shopify customer whose email
 * matches exactly, the customer gets the `support` tag and its
 * `support.tickets` metafield lists the tickets (reference, topic, status,
 * opened, Discord link), and staff see that customer's recent orders in the
 * ticket thread.
 *
 * Rules that keep one customer's data away from another:
 * - a link needs exactly one customer whose email equals the ticket email
 *   (case-insensitive); zero or several link nothing;
 * - an order number typed into the form is shown to staff with its details
 *   only when that order belongs to the ticket's email or linked customer;
 * - nothing read here is ever sent to the customer's browser.
 *
 * Writes (tag and metafield) happen only with SUPPORT_SHOPIFY_WRITE_ENABLED
 * set to '1'. Admin token scopes: read_customers, write_customers,
 * read_orders.
 */

import {devOverride} from './dev-overrides.ts';

const DEFAULT_VERSION = '2026-07';

export type ShopifyEnv = {
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_ADMIN_API_TOKEN?: string;
  SHOPIFY_ADMIN_API_VERSION?: string;
  SUPPORT_SHOPIFY_WRITE_ENABLED?: string;
  SUPPORT_DEV_SHOPIFY_ADMIN_URL?: string;
};

export type OrderSummary = {
  name: string;
  createdAt: string;
  financial: string | null;
  fulfillment: string | null;
  batchTags: string[];
  items: Array<{sku: string | null; title: string; quantity: number}>;
};

export type CustomerContext =
  | {match: 'matched'; customerId: string; ordersCount: number; orders: OrderSummary[]; tickets: SupportTicketEntry[]}
  | {match: 'unverified' | 'none' | 'multiple' | 'unchecked'};

export type SupportTicketEntry = {ref: string; topic: string; status: string; opened: string; link: string};

type Fetcher = typeof fetch;

export function adminEndpoint(env: ShopifyEnv): {url: string; token: string} | null {
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  const sandbox =
    typeof import.meta.env !== 'undefined' && import.meta.env.DEV ? devOverride(env.SUPPORT_DEV_SHOPIFY_ADMIN_URL) : null;
  if (sandbox) return {url: sandbox, token: token || 'dev'};
  const domain = env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!domain || !token || !/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(domain)) return null;
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || DEFAULT_VERSION;
  if (!/^\d{4}-(01|04|07|10)$/.test(version)) return null;
  return {url: `https://${domain}/admin/api/${version}/graphql.json`, token};
}

export function shopifyConfigured(env: ShopifyEnv): boolean {
  return adminEndpoint(env) !== null;
}

/** Admin link to a customer, for the staff-only metadata post. */
export function customerAdminUrl(env: ShopifyEnv, customerId: string): string | null {
  const sandbox =
    typeof import.meta.env !== 'undefined' && import.meta.env.DEV ? devOverride(env.SUPPORT_DEV_SHOPIFY_ADMIN_URL) : null;
  if (sandbox) return `${sandbox}/customers/${customerId.match(/(\d+)$/)?.[1] ?? ''}`;
  const handle = env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase().match(/^(?:https?:\/\/)?([a-z0-9-]+)\.myshopify\.com/)?.[1];
  const id = customerId.match(/(\d+)$/)?.[1];
  return handle && id ? `https://admin.shopify.com/store/${handle}/customers/${id}` : null;
}

async function gql<T>(env: ShopifyEnv, query: string, variables: Record<string, unknown>, fetcher: Fetcher): Promise<T> {
  const ep = adminEndpoint(env);
  if (!ep) throw new Error('shopify admin not configured');
  const res = await fetcher(ep.url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': ep.token},
    body: JSON.stringify({query, variables}),
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`shopify admin ${res.status}`);
  const body = (await res.json()) as {data?: T; errors?: unknown[]};
  if (body.errors?.length || !body.data) throw new Error('shopify admin graphql error');
  return body.data;
}

// Emails reach the query only after this check, so no quote or space can
// break out of the search expression.
const EMAIL_RE = /^[^\s@"'\\]+@[^\s@"'\\]+\.[^\s@"'\\]+$/;

export function isEmail(s: string): boolean {
  return s.length <= 254 && EMAIL_RE.test(s);
}

/** "1042", "#1042", " # 1042 " -> "#1042"; anything else -> null. */
export function normalizeOrderNumber(input: string | null | undefined): string | null {
  const digits = (input ?? '').trim().replace(/^#\s*/, '');
  return /^\d{3,10}$/.test(digits) ? `#${digits}` : null;
}

const ORDER_FIELDS = `name createdAt displayFinancialStatus displayFulfillmentStatus tags
  lineItems(first: 10) { nodes { sku title quantity } }`;

const CUSTOMER_QUERY = `query SupportCustomer($q: String!) {
  customers(first: 5, query: $q) {
    nodes {
      id email numberOfOrders
      metafield(namespace: "support", key: "tickets") { value }
      orders(first: 5, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } }
    }
  }
}`;

const ORDER_QUERY = `query SupportOrder($q: String!) {
  orders(first: 3, query: $q) { nodes { email customer { id } ${ORDER_FIELDS} } }
}`;

type RawOrder = {
  name: string;
  createdAt: string;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  tags?: string[];
  lineItems?: {nodes: Array<{sku: string | null; title: string; quantity: number}>};
};

function summarize(o: RawOrder): OrderSummary {
  return {
    name: o.name,
    createdAt: o.createdAt,
    financial: o.displayFinancialStatus ?? null,
    fulfillment: o.displayFulfillmentStatus ?? null,
    batchTags: (o.tags ?? []).filter((t) => /^(batch:|preorder)/i.test(t)),
    items: (o.lineItems?.nodes ?? []).map((l) => ({sku: l.sku, title: l.title, quantity: l.quantity})),
  };
}

function parseEntries(value: string | null | undefined): SupportTicketEntry[] {
  if (!value) return [];
  try {
    const v = JSON.parse(value) as unknown;
    return Array.isArray(v) ? (v as SupportTicketEntry[]).filter((e) => typeof e?.ref === 'string') : [];
  } catch {
    return [];
  }
}

/** The customer whose email equals `email`, with recent orders. Never throws. */
export async function lookupCustomer(env: ShopifyEnv, email: string, fetcher: Fetcher = fetch): Promise<CustomerContext> {
  if (!shopifyConfigured(env) || !isEmail(email)) return {match: 'unchecked'};
  try {
    const data = await gql<{
      customers: {
        nodes: Array<{
          id: string;
          email: string | null;
          numberOfOrders?: string | number;
          metafield?: {value: string} | null;
          orders?: {nodes: RawOrder[]};
        }>;
      };
    }>(env, CUSTOMER_QUERY, {q: `email:"${email}"`}, fetcher);
    const exact = data.customers.nodes.filter((c) => (c.email ?? '').toLowerCase() === email.toLowerCase());
    if (exact.length === 0) return {match: 'none'};
    if (exact.length > 1) return {match: 'multiple'};
    const c = exact[0]!;
    return {
      match: 'matched',
      customerId: c.id,
      ordersCount: Number(c.numberOfOrders ?? 0),
      orders: (c.orders?.nodes ?? []).map(summarize),
      tickets: parseEntries(c.metafield?.value),
    };
  } catch (err) {
    console.warn('[support] shopify customer lookup failed', err instanceof Error ? err.message : 'error');
    return {match: 'unchecked'};
  }
}

/**
 * The order named `orderNumber` if it belongs to `email` or `customerId`;
 * null when it does not exist, belongs to someone else, or Shopify cannot
 * answer. Never throws.
 */
export async function ownedOrder(
  env: ShopifyEnv,
  orderNumber: string,
  email: string,
  customerId: string | null,
  fetcher: Fetcher = fetch,
): Promise<OrderSummary | null> {
  const name = normalizeOrderNumber(orderNumber);
  if (!name || !shopifyConfigured(env)) return null;
  try {
    const data = await gql<{orders: {nodes: Array<RawOrder & {email?: string | null; customer?: {id: string} | null}>}}>(
      env,
      ORDER_QUERY,
      {q: `name:"${name}"`},
      fetcher,
    );
    const hit = data.orders.nodes.find(
      (o) =>
        o.name === name &&
        (((o.email ?? '').toLowerCase() === email.toLowerCase() && email.length > 0) ||
          (customerId !== null && o.customer?.id === customerId)),
    );
    return hit ? summarize(hit) : null;
  } catch (err) {
    console.warn('[support] shopify order lookup failed', err instanceof Error ? err.message : 'error');
    return null;
  }
}

const TAGS_ADD = `mutation SupportTag($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { userErrors { message } }
}`;

const METAFIELD_SET = `mutation SupportTickets($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { userErrors { message } }
}`;

const METAFIELD_READ = `query SupportTicketsRead($id: ID!) {
  customer(id: $id) { metafield(namespace: "support", key: "tickets") { value } }
}`;

export function shopifyWritesEnabled(env: ShopifyEnv): boolean {
  return env.SUPPORT_SHOPIFY_WRITE_ENABLED === '1' && shopifyConfigured(env);
}

/**
 * Put `entry` on the customer's ticket list (replacing the same reference)
 * or, with `remove`, take it off. Adds the `support` tag with `tag` (a new
 * ticket only, not every status change). Returns
 * whether Shopify was written. Never throws.
 */
export async function recordOnCustomer(
  env: ShopifyEnv,
  customerId: string,
  entry: SupportTicketEntry,
  opts: {remove?: boolean; tag?: boolean} = {},
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  if (!shopifyWritesEnabled(env)) return false;
  try {
    const read = await gql<{customer: {metafield: {value: string} | null} | null}>(env, METAFIELD_READ, {id: customerId}, fetcher);
    if (!read.customer) return false;
    const others = parseEntries(read.customer.metafield?.value).filter((e) => e.ref !== entry.ref);
    const list = opts.remove ? others : [entry, ...others].slice(0, 50);
    const set = await gql<{metafieldsSet: {userErrors: Array<{message: string}>}}>(
      env,
      METAFIELD_SET,
      {metafields: [{ownerId: customerId, namespace: 'support', key: 'tickets', type: 'json', value: JSON.stringify(list)}]},
      fetcher,
    );
    if (set.metafieldsSet.userErrors.length) throw new Error('metafieldsSet userErrors');
    if (opts.tag && !opts.remove) {
      const tag = await gql<{tagsAdd: {userErrors: Array<{message: string}>}}>(env, TAGS_ADD, {id: customerId, tags: ['support']}, fetcher);
      if (tag.tagsAdd.userErrors.length) throw new Error('tagsAdd userErrors');
    }
    return true;
  } catch (err) {
    console.warn('[support] shopify customer write failed', err instanceof Error ? err.message : 'error');
    return false;
  }
}
