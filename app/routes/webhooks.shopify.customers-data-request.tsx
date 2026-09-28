import type {Route} from './+types/webhooks.shopify.customers-data-request';
import {complianceWebhooksActive, handleComplianceWebhook} from '~/lib/accounts/compliance';
import {notFound} from '~/lib/accounts/config';

/**
 * POST /webhooks/shopify/customers-data-request: Shopify `customers/data_request` webhook
 * (app/lib/accounts/compliance.ts): records the request; the scheduled job builds the export for the founder CLI. Signed with
 * SHOPIFY_WEBHOOK_SECRET; live whenever that secret is set, whatever ACCOUNTS_ENABLED says.
 */
export function action({request, context}: Route.ActionArgs) {
  return handleComplianceWebhook('customers/data_request', request, context.env);
}

export function loader({context}: Route.LoaderArgs) {
  if (!complianceWebhooksActive(context.env)) return notFound();
  return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST', 'Cache-Control': 'no-store'}});
}
