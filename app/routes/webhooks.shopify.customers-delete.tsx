import type {Route} from './+types/webhooks.shopify.customers-delete';
import {complianceWebhooksActive, handleComplianceWebhook} from '~/lib/accounts/compliance';
import {notFound} from '~/lib/accounts/config';

/**
 * POST /webhooks/shopify/customers-delete: Shopify `customers/delete` webhook
 * (app/lib/accounts/compliance.ts): the fallback when Shopify refuses compliance topics for the custom app: erases like customers/redact. Signed with
 * SHOPIFY_WEBHOOK_SECRET; live whenever that secret is set, whatever ACCOUNTS_ENABLED says.
 */
export function action({request, context}: Route.ActionArgs) {
  return handleComplianceWebhook('customers/delete', request, context.env);
}

export function loader({context}: Route.LoaderArgs) {
  if (!complianceWebhooksActive(context.env)) return notFound();
  return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST', 'Cache-Control': 'no-store'}});
}
