import {redirect} from 'react-router';
import type {Route} from './+types/account.$';
import {customerAccountUrl} from '~/lib/shop-links';

/**
 * Legacy account URLs go to the configured Shopify customer account root.
 * That root must be an explicitly configured HTTPS customer account URL; no
 * order, invoice or address endpoint is invented.
 *
 * /account/support is the exception: the support desk never belonged to
 * the shop, so it lands on the support page.
 */
export function loader({params, context}: Route.LoaderArgs) {
  const rest = (params['*'] ?? '').replace(/^\/+/, '');
  if (/^support(\/|$)/.test(rest)) {
    throw redirect('/support?existing=1', 301);
  }
  const destination = customerAccountUrl(context.env);
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
