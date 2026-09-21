/**
 * Checkout Click - the Plausible funnel event (cart or express-item value
 * as revenue). One helper so every checkout entry point (the cart CTA in
 * CartSummary, and the PDP ShopPay express button in ProductForm, added
 * in #304, which bypasses the cart entirely) fires the same event shape.
 *
 * Used to also beacon /api/track/checkout to bump a server-side
 * `chk:<day>` click counter (a home-grown buy-rate denominator). Removed
 * with the Upstash migration (founder decision, 2026-09-15): its
 * numerator (`ord:<order_id>`, written by the Shopify orders webhook) had
 * already gone dead when that webhook route started returning 410 Gone,
 * and nothing ever read the denominator
 * counter on its own (no report or dashboard queried it) - a live write
 * into a metric whose other half was already broken. Checkout-intent
 * visibility lives in Plausible via the event below.
 */
import {trackEvent} from '~/lib/growth/plausible';
import {attributionSource} from '~/lib/growth/attribution';

export function trackCheckoutClick(
  revenue?: {currency: string; amount: number} | null,
): void {
  trackEvent('Checkout Click', {
    props: {source: attributionSource()},
    ...(revenue && Number.isFinite(revenue.amount) ? {revenue} : {}),
  });
}
