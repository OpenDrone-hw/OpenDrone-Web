/**
 * Server-side Plausible `Purchase` event (Events API), sent from the
 * Shopify `orders/paid` webhook.
 *
 * The buyer pays on Shopify's checkout domain, outside our pages, so the
 * funnel's last step cannot be a client event. The webhook posts it to
 * https://plausible.io/api/event instead (no API key; the domain must be a
 * site on the Plausible account).
 *
 * Plausible drops an event that arrives from a server or CDN address
 * (answering 202 with `x-plausible-dropped: 1`), so the event forwards the
 * buyer's own browser IP and User-Agent from the order's client details,
 * as Plausible's Events API asks. Plausible keeps no IP address; it hashes
 * IP and User-Agent into a daily visitor id, the same as for a page view.
 * Off unless `PLAUSIBLE_PURCHASE_EVENTS_ENABLED` is `1`.
 *
 * Props use the same bounded vocabulary as the client events: `source`
 * folded to the canonical list, the creator `ref` slug, `campaign`,
 * shipping `country` and the order's `skus`. Channel comes from the
 * order's note attributes (`_ref`, `_utm_*`, written from cart attributes
 * at the first add to cart), not from a referrer.
 *
 * Degrade-soft: never throws, returns false on any failure. The caller
 * runs it inside waitUntil so the webhook answer is never delayed.
 */

import {foldSource, ORDER_ATTRIBUTE, refSlug} from './attribution.ts';

/** The Plausible site domain, matching data-domain in root.tsx. */
export const PLAUSIBLE_DOMAIN = 'opendrone.be';

const EVENT_ENDPOINT = 'https://plausible.io/api/event';

export type PurchaseEvent = {
  /** Shopify order id, for dedupe and logs only; never sent. */
  orderId: string;
  /** Order total in major units (e.g. euros), shop currency. */
  total: number;
  /** ISO 4217, e.g. 'EUR'. */
  currency: string;
  /** Raw first-touch utm_source (or ref) from the order, if any. */
  source?: string;
  ref?: string;
  campaign?: string;
  /** Shipping country, ISO 3166 alpha-2. */
  country?: string;
  /** Distinct SKUs of the order, sorted, joined with `+`. */
  skus?: string;
  /** The buyer's browser IP and User-Agent from the order. */
  ip?: string;
  userAgent?: string;
};

type OrderWebhook = {
  id?: number | string;
  test?: boolean;
  total_price?: string;
  currency?: string;
  note_attributes?: Array<{name?: string; value?: string}>;
  browser_ip?: string | null;
  client_details?: {browser_ip?: string | null; user_agent?: string | null} | null;
  shipping_address?: {country_code?: string | null} | null;
  line_items?: Array<{sku?: string | null}>;
};

const SAFE = /^[a-z0-9._~%+-]{1,64}$/;

/** The Purchase event an `orders/paid` payload describes, or null when it
 *  is not a usable order (test order, no id, no total). */
export function purchaseFromOrder(payload: unknown): PurchaseEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const order = payload as OrderWebhook;
  if (order.test) return null;
  const orderId = order.id != null ? String(order.id) : '';
  const total = Number(order.total_price);
  const currency = String(order.currency ?? '').toUpperCase();
  if (!orderId || !Number.isFinite(total) || total <= 0 || !/^[A-Z]{3}$/.test(currency)) return null;
  const attribute = (key: string) => {
    const value = order.note_attributes?.find((a) => a.name === key)?.value?.trim().toLowerCase();
    return value && SAFE.test(value) ? value : undefined;
  };
  const ref = refSlug(attribute(ORDER_ATTRIBUTE.ref));
  const source = attribute(ORDER_ATTRIBUTE.utmSource) ?? ref;
  const campaign = attribute(ORDER_ATTRIBUTE.campaign);
  const country = order.shipping_address?.country_code?.toUpperCase();
  const skus = [...new Set((order.line_items ?? []).map((l) => l.sku?.trim()).filter((s): s is string => Boolean(s)))]
    .sort()
    .join('+')
    .slice(0, 200);
  const ip = (order.client_details?.browser_ip ?? order.browser_ip ?? '').trim();
  const userAgent = (order.client_details?.user_agent ?? '').trim();
  return {
    orderId,
    total,
    currency,
    ...(source ? {source} : {}),
    ...(ref ? {ref} : {}),
    ...(campaign ? {campaign} : {}),
    ...(country && /^[A-Z]{2}$/.test(country) ? {country} : {}),
    ...(skus ? {skus} : {}),
    ...(ip ? {ip} : {}),
    ...(userAgent ? {userAgent: userAgent.slice(0, 512)} : {}),
  };
}

/** The Events API request body for a purchase. */
export function purchaseBody(event: PurchaseEvent): Record<string, unknown> {
  return {
    name: 'Purchase',
    domain: PLAUSIBLE_DOMAIN,
    // Synthetic but stable URL: the event has no page of ours. Kept
    // constant so it never fragments by URL in the dashboard.
    url: `https://${PLAUSIBLE_DOMAIN}/purchase`,
    props: {
      source: foldSource(event.source),
      ...(event.ref ? {ref: event.ref} : {}),
      ...(event.campaign ? {campaign: event.campaign} : {}),
      ...(event.country ? {country: event.country} : {}),
      ...(event.skus ? {skus: event.skus} : {}),
    },
    revenue: {currency: event.currency, amount: event.total},
  };
}

/**
 * POST one `Purchase` event with revenue. True only when Plausible
 * accepted it and did not drop it. An order without the buyer's IP and
 * User-Agent is not sent: Plausible would drop it as server traffic.
 */
export async function sendPurchaseEvent(
  event: PurchaseEvent,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!event.ip || !event.userAgent) {
    console.warn('[growth/plausible-server] Purchase event skipped: order has no browser IP or User-Agent', event.orderId);
    return false;
  }
  try {
    const res = await fetcher(EVENT_ENDPOINT, {
      method: 'POST',
      // Hard timeout: this runs inside the webhook's waitUntil budget.
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        'user-agent': event.userAgent,
        'x-forwarded-for': event.ip,
      },
      body: JSON.stringify(purchaseBody(event)),
    });
    if (res.status !== 202 || res.headers.get('x-plausible-dropped') === '1') {
      console.warn('[growth/plausible-server] Purchase event not recorded', event.orderId, res.status);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[growth/plausible-server] Purchase event failed', event.orderId, err instanceof Error ? err.message : 'unknown error');
    return false;
  }
}

/** The gate: only an explicit `1` sends purchase events. */
export function purchaseEventsEnabled(env: {PLAUSIBLE_PURCHASE_EVENTS_ENABLED?: string}): boolean {
  return env.PLAUSIBLE_PURCHASE_EVENTS_ENABLED === '1';
}
