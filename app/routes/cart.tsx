import {redirect} from 'react-router';
import type {Route} from './+types/cart';
import {shopUrl} from '~/lib/catalog-client';
import {portalUrl} from '~/lib/shop-links';

/** The live cart is owned by Odoo. */
export function loader({context}: Route.LoaderArgs) {
  throw redirect(portalUrl(shopUrl(context.env), 'cart'), 301);
}
