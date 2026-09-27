import type {Route} from './+types/webhooks.shopify.customers-redact';
import {accountsEnabled, notFound} from '~/lib/accounts/config';
import {handleComplianceWebhook} from '~/lib/accounts/rights';

/**
 * POST /webhooks/shopify/customers-redact: Shopify `customers/redact` compliance
 * webhook for shared accounts (app/lib/accounts/rights.ts). Signed with
 * SHOPIFY_WEBHOOK_SECRET; 404 while ACCOUNTS_ENABLED is not "1".
 */
export function action({request, context}: Route.ActionArgs) {
  return handleComplianceWebhook('customers/redact', request, context.env);
}

export function loader({context}: Route.LoaderArgs) {
  if (!accountsEnabled(context.env)) return notFound();
  return new Response('Method not allowed', {status: 405, headers: {Allow: 'POST', 'Cache-Control': 'no-store'}});
}
