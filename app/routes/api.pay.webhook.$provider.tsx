import type {Route} from './+types/api.pay.webhook.$provider';
import {handlePayWebhook} from '~/lib/commerce/pay-webhook';

/**
 * Provider payment webhooks, app mode only (COMMERCE_SOURCE=app; 404 otherwise). Relays the payment id to the
 * app, which refetches the payment. See app/lib/commerce/pay-webhook.ts.
 */
export function loader() {
  throw new Response('Not found', {status: 404});
}

export async function action({request, params, context}: Route.ActionArgs) {
  return handlePayWebhook(request, params.provider ?? '', context.env);
}
