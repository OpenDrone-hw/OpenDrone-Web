/**
 * Server-side Plausible events (Events API).
 *
 * The buyer finishes payment on Shopify's checkout domain, outside our
 * pages, so the funnel's final step cannot be a client event. The
 * orders/paid webhook posts a `Purchase` event with revenue straight to
 * the Plausible Events API instead (https://plausible.io/api/event, no
 * API key needed for event ingestion; the domain must simply be a site
 * registered on the account).
 *
 * Caveats, accepted by design:
 * - Every server event carries the same synthetic User-Agent and no
 *   client IP, so Plausible attributes them all to one "visitor" and no
 *   session/funnel join to the buyer's browsing exists. Event counts,
 *   revenue totals, and the source/campaign prop breakdowns are what
 *   this is for; visitor counts on this event are meaningless.
 * - Channel comes from the order's `_utm_*` note_attributes (first-touch
 *   attribution promoted through cart attributes), not from a referrer.
 * - Dedupe is the caller's job: the webhook route sends only on the
 *   orders/paid topic, claims `pev:<order_id>` atomically (SETNX) before
 *   sending, and stamps `purchaseEventAt` on the ledger order record, so
 *   redeliveries and the orders/create + orders/paid pair do not
 *   double-count revenue.
 *
 * Degrade-soft like everything else in growth/: never throws, returns
 * false on any failure, and callers run it inside waitUntil so the
 * webhook 200 is never blocked.
 */

import {foldSource} from '~/lib/growth/attribution';

/** The Plausible site domain, matching data-domain in root.tsx. */
export const PLAUSIBLE_DOMAIN = 'opendrone.be';

const EVENT_ENDPOINT = 'https://plausible.io/api/event';

// A stable, honest UA: Plausible requires the header, and an identifiable
// value keeps our server events distinguishable in any debugging.
const USER_AGENT = 'OpenDroneStorefront-OrderWebhook/1.0 (+https://opendrone.store)';

export type PurchaseEvent = {
  /** Order total in major units (e.g. euros). */
  total: number;
  /** ISO 4217, e.g. 'EUR'. */
  currency: string;
  /** First-touch utm_source from the order attribution, else 'direct'. */
  source?: string;
  /** First-touch utm_campaign, omitted when absent. */
  campaign?: string;
};

/**
 * POST one `Purchase` event with revenue. Returns true only when
 * Plausible accepted it (HTTP 202); the caller uses that to set the
 * dedupe latch, so a transient failure stays retryable on webhook
 * redelivery.
 */
export async function sendPurchaseEvent(
  event: PurchaseEvent,
): Promise<boolean> {
  try {
    const res = await fetch(EVENT_ENDPOINT, {
      method: 'POST',
      // Hard timeout: this runs inside the webhook's waitUntil budget,
      // and a hanging Plausible endpoint must fail fast (the claim is
      // released and a redelivery retries) instead of stalling the job.
      signal: AbortSignal.timeout(5000),
      headers: {
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        name: 'Purchase',
        domain: PLAUSIBLE_DOMAIN,
        // Synthetic but stable URL: server events have no real page. Kept
        // constant so the event never fragments by URL in the dashboard.
        url: `https://${PLAUSIBLE_DOMAIN}/purchase`,
        props: {
          // Same bounded vocabulary as the client events, so filtering a
          // funnel by `source` matches end to end.
          source: foldSource(event.source),
          ...(event.campaign ? {campaign: event.campaign} : {}),
        },
        ...(Number.isFinite(event.total) && event.total > 0
          ? {revenue: {currency: event.currency, amount: event.total}}
          : {}),
      }),
    });
    if (res.status !== 202) {
      const body = await res.text().catch(() => '');
      console.warn(
        '[growth/plausible-server] Purchase event rejected',
        res.status,
        body.slice(0, 200),
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[growth/plausible-server] Purchase event failed', err);
    return false;
  }
}
