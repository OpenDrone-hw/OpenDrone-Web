import {redirect} from 'react-router';
import type {Route} from './+types/account';
import {shopUrl} from '~/lib/catalog-client';
import {portalUrl} from '~/lib/shop-links';

/** The customer account home is the Odoo portal. */
export function loader({context}: Route.LoaderArgs) {
  throw redirect(portalUrl(shopUrl(context.env), 'account'), 301);
}
