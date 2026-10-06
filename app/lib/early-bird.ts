/**
 * Early Bird: a paid OpenDrone preorder unlocks the Early Bird role and the
 * private #early-birds channel on the OpenDrone Discord, for one Discord
 * account per order.
 *
 * This Worker decides who qualifies and proves the buyer; the Discord bot
 * Worker (OpenDrone-hw/discord, bot/src/linked-roles/early-bird.ts) runs the
 * Discord authorization, records the claim (first account per order wins)
 * and gives the role. The hand-off is a claim token signed with the
 * EARLY_BIRD_CLAIM_KEY secret both Workers hold, valid 10 minutes.
 *
 * | Way to claim | Proof of the order |
 * |---|---|
 * | Signed in on opendrone.be (`/early-bird`, `/account`) | The order belongs to the session's Shopify customer |
 * | Link in the order confirmation mail | `key` equals the key of the order's Shopify status page URL, which only that mail and the order status page carry |
 *
 * Qualifies: placed before the preorder run closes (`endsOn`, end of day in
 * Brussels), paid or partly refunded, not cancelled, and a preorder (the
 * `preorder` tag, or a line with the `Preorder` cart attribute for an order
 * the tag job has not reached yet).
 *
 * Nothing is stored here. Kept free of worker APIs and path aliases so
 * node:test can load it directly.
 */
import {adminGraphql, type AdminEnv} from './preorder-fulfilment.ts';
import {campaignEndsAt} from './preorder-campaign.ts';

export const CLAIM_TTL_SECONDS = 600;
/** The bot Worker's claim route; EARLY_BIRD_CLAIM_URL overrides it (staging). */
export const DEFAULT_CLAIM_URL = 'https://opendrone-discord-bot.sales-ee0.workers.dev/early-bird';
const PAID = new Set(['PAID', 'PARTIALLY_REFUNDED']);

export type EarlyBirdEnv = AdminEnv & {EARLY_BIRD_CLAIM_KEY?: string; EARLY_BIRD_CLAIM_URL?: string};

export type EarlyBirdOrder = {
  /** Shopify order GID. */
  id: string;
  /** "#1042". */
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  tags: string[];
  statusPageUrl: string | null;
  customer: {id: string} | null;
  lineItems: {nodes: {customAttributes: {key: string; value: string | null}[]}[]};
};

export type Ineligible = 'not-paid' | 'cancelled' | 'not-preorder' | 'too-late';

const ORDER_FIELDS = `
  id name createdAt cancelledAt displayFinancialStatus tags statusPageUrl
  customer { id }
  lineItems(first: 50) { nodes { customAttributes { key value } } }
`;

const ORDER_QUERY = `#graphql
  query OpenDroneEarlyBirdOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }
`;

const CUSTOMER_ORDERS_QUERY = `#graphql
  query OpenDroneEarlyBirdOrders($id: ID!) {
    customer(id: $id) { orders(first: 50, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }
  }
`;

/** Why an order does not qualify, or null when it does. */
export function ineligibility(order: EarlyBirdOrder, endsOn: string): Ineligible | null {
  if (order.cancelledAt) return 'cancelled';
  if (!PAID.has(order.displayFinancialStatus ?? '')) return 'not-paid';
  const preorder =
    order.tags.includes('preorder') ||
    order.lineItems.nodes.some((line) => line.customAttributes.some((a) => a.key === 'Preorder' && a.value));
  if (!preorder) return 'not-preorder';
  if (Date.parse(order.createdAt) >= campaignEndsAt(endsOn).getTime()) return 'too-late';
  return null;
}

/** "gid://shopify/Order/123" for a numeric id from the mail link, else null. */
export function orderGid(numericId: string | null): string | null {
  return numericId && /^\d{1,20}$/.test(numericId) ? `gid://shopify/Order/${numericId}` : null;
}

/** The `key` query parameter of a Shopify order status URL. */
export function statusKey(statusPageUrl: string | null): string | null {
  if (!statusPageUrl) return null;
  try {
    return new URL(statusPageUrl).searchParams.get('key') || null;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();

function equalStrings(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** The mail link's key matches the order's status page key. */
export function mailKeyMatches(order: Pick<EarlyBirdOrder, 'statusPageUrl'>, key: string | null): boolean {
  const expected = statusKey(order.statusPageUrl);
  return Boolean(expected && key && equalStrings(expected, key));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * "v1." + base64url(JSON {o, n, exp}) + "." + base64url(HMAC-SHA256 of the
 * part before it), as bot/src/linked-roles/early-bird.ts verifies it.
 */
export async function signClaimToken(secret: string, order: Pick<EarlyBirdOrder, 'id' | 'name'>, exp: number): Promise<string> {
  const body = `v1.${base64Url(encoder.encode(JSON.stringify({o: order.id, n: order.name, exp})))}`;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return `${body}.${base64Url(mac)}`;
}

/** Where the browser goes to finish the claim on Discord. */
export async function claimUrl(env: EarlyBirdEnv, order: Pick<EarlyBirdOrder, 'id' | 'name'>, now = Date.now()): Promise<string> {
  const secret = env.EARLY_BIRD_CLAIM_KEY;
  if (!secret) throw new Error('early bird: EARLY_BIRD_CLAIM_KEY is not set');
  const token = await signClaimToken(secret, order, Math.floor(now / 1000) + CLAIM_TTL_SECONDS);
  const url = new URL(env.EARLY_BIRD_CLAIM_URL || DEFAULT_CLAIM_URL);
  url.searchParams.set('t', token);
  return url.toString();
}

export async function readOrder(env: AdminEnv, id: string, fetcher: typeof fetch = fetch): Promise<EarlyBirdOrder | null> {
  const data = await adminGraphql<{order: EarlyBirdOrder | null}>(env, ORDER_QUERY, {id}, fetcher);
  return data.order;
}

/** The customer's latest 50 orders, newest first; null when the customer is not found. */
export async function readCustomerOrders(env: AdminEnv, customerGid: string, fetcher: typeof fetch = fetch): Promise<EarlyBirdOrder[] | null> {
  const data = await adminGraphql<{customer: {orders: {nodes: EarlyBirdOrder[]}} | null}>(
    env,
    CUSTOMER_ORDERS_QUERY,
    {id: customerGid},
    fetcher,
  );
  return data.customer ? data.customer.orders.nodes : null;
}
