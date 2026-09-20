import {redirect} from 'react-router';
import type {Route} from './+types/account.$';
import {customerAccountUrl} from '~/lib/shop-links';
import {shopUrl} from '~/lib/catalog-client';
import {supportHistoryDestination} from '~/lib/support/session';

/**
 * Legacy account URLs go to the configured provider-owned account root.
 * During Shopify preview that root must be an explicitly configured HTTPS
 * customer account URL; no order, invoice or address endpoint is invented.
 *
 * /account/support is the exception: the support desk never belonged to
 * the shop, and its ticket list is now /support/tickets in this app.
 */
export function loader({params, context}: Route.LoaderArgs) {
  const rest = (params['*'] ?? '').replace(/^\/+/, '');
  if (/^support(\/|$)/.test(rest)) {
    throw redirect(supportHistoryDestination(context.catalog.shopifyPreview), 301);
  }
  const shop = shopUrl(context.env);
  const destination = customerAccountUrl(
    context.env,
    shop,
    context.catalog.shopifyPreview,
  );
  if (!destination) {
    throw new Response('Customer accounts are not configured.', {
      status: 404,
      headers: {'Cache-Control': 'no-store'},
    });
  }
  // Shopify owns its account navigation. Legacy order/profile/address/login
  // paths all land on the exact configured account URL; this app does not
  // invent provider subpaths or claim an invoice view exists.
  throw redirect(destination, 301);
}
