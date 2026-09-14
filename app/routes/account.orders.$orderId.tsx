import {redirect} from 'react-router';
import type {Route} from './+types/account.orders.$orderId';
import {shopUrl} from '~/lib/catalog-client';
import {portalUrl} from '~/lib/shop-links';

/**
 * A legacy Shopify order id cannot identify an Odoo order safely. Preserve
 * the route by taking the signed-in customer to their Odoo order list.
 */
export function loader({context}: Route.LoaderArgs) {
  throw redirect(portalUrl(shopUrl(context.env), 'orders'), 301);
}
