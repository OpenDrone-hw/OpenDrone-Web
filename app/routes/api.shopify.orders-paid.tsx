/**
 * Shopify `orders/paid` webhook: step a SKU's price when its paid count
 * crosses a tier.
 *
 * Shopify signs the body with `SHOPIFY_WEBHOOK_SECRET`; without that secret,
 * or with a signature that does not match the body, the request is refused
 * and nothing is read or written. The body itself is not trusted for the
 * count: it only says which SKUs to re-read. The count always comes from the
 * Admin API (`fetchPaidUnits`), so a replayed or forged-shaped payload cannot
 * move a price on its own.
 *
 * After the price steps, every paid preorder order that is not yet done is
 * put on hold and tagged by batch (`app/lib/preorder-fulfilment.ts`), so the
 * bpost plugin cannot import it for a label before its batch ships. The
 * pass re-reads all campaign orders, so it also covers an order Shopify's
 * search index has not caught up with on the next run.
 *
 * Shopify wants a 2xx within 5 seconds and removes a webhook that keeps
 * failing. A full reconcile re-reads every campaign order, which a launch-day
 * burst pushes past that, so a verified delivery answers 202 at once and the
 * reconcile runs after the response (`waitUntil`). A failure there is logged
 * and retried by the five-minute scheduled reconcile in `server.ts`.
 */

import type {ActionFunctionArgs} from 'react-router';
import {parseCampaignConfig} from '~/lib/preorder-campaign';
import {reconcilePreorders} from '~/lib/preorder-ops';
import {priceTierWritesEnabled} from '~/lib/shopify-price-tier';
import {verifyShopifyHmac} from '~/lib/shopify-webhook';
import preordersJson from '../../content/preorders.json';

export async function action({request, context}: ActionFunctionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST'}});
  }
  const env = context.env;
  const secret = env.SHOPIFY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return new Response('Webhook not configured', {status: 503, headers: {'Cache-Control': 'no-store'}});
  }
  const body = await request.text();
  const valid = await verifyShopifyHmac(secret, body, request.headers.get('X-Shopify-Hmac-Sha256'));
  if (!valid) {
    return new Response('Bad signature', {status: 401, headers: {'Cache-Control': 'no-store'}});
  }
  if (!priceTierWritesEnabled(env)) {
    return new Response('Price tier writes are off', {status: 200, headers: {'Cache-Control': 'no-store'}});
  }

  const config = parseCampaignConfig(preordersJson);
  context.waitUntil(
    reconcilePreorders(env, config).then(
      (result) => {
        const holdErrors = Object.keys(result.holdErrors).length;
        if (holdErrors) console.error('[orders-paid] hold errors', result.holdErrors);
      },
      (error: unknown) => console.error('[orders-paid] reconcile failed', error),
    ),
  );
  return new Response('Accepted', {status: 202, headers: {'Cache-Control': 'no-store'}});
}

/** A webhook endpoint answers POST only. */
export function loader() {
  return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST'}});
}
