import type {Route} from './+types/webhooks.shopify.shop-redact';
import {complianceWebhooksActive, handleComplianceWebhook} from '~/lib/accounts/compliance';
import {notFound} from '~/lib/accounts/config';

/**
 * POST /webhooks/shopify/shop-redact: Shopify `shop/redact` webhook
 * (app/lib/accounts/compliance.ts): recorded; the store holds nothing else to delete. Signed with
 * SHOPIFY_WEBHOOK_SECRET; live whenever that secret is set, whatever ACCOUNTS_ENABLED says.
 */
export function action({request, context}: Route.ActionArgs) {
  return handleComplianceWebhook('shop/redact', request, context.env);
}

export function loader({context}: Route.LoaderArgs) {
  if (!complianceWebhooksActive(context.env)) return notFound();
  return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST', 'Cache-Control': 'no-store'}});
}
