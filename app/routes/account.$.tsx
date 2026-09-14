import {redirect} from 'react-router';
import type {Route} from './+types/account.$';
import {portalUrl, type PortalTarget} from '~/lib/shop-links';
import {shopUrl} from '~/lib/catalog-client';

/**
 * Accounts, orders, invoices and addresses live in the Odoo portal on the
 * shop (contract section 4). The old /account/* routes 301 there so every
 * indexed or bookmarked URL still lands on the right page.
 *
 * /account/support is the exception: the support desk never belonged to
 * the shop, and its ticket list is now /support/tickets in this app.
 */
const TARGETS: Array<[RegExp, PortalTarget]> = [
  [/^orders(\/|$)/, 'orders'],
  [/^addresses(\/|$)/, 'addresses'],
  [/^profile(\/|$)/, 'profile'],
  [/^welcome(\/|$)/, 'profile'],
  [/^login(\/|$)/, 'login'],
  [/^authorize(\/|$)/, 'login'],
  [/^logout(\/|$)/, 'logout'],
];

export function loader({params, context}: Route.LoaderArgs) {
  const rest = (params['*'] ?? '').replace(/^\/+/, '');
  if (/^support(\/|$)/.test(rest)) throw redirect('/support/tickets', 301);
  const shop = shopUrl(context.env);
  const match = TARGETS.find(([pattern]) => pattern.test(rest));
  throw redirect(portalUrl(shop, match ? match[1] : 'account'), 301);
}
