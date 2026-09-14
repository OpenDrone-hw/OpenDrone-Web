import {redirect} from 'react-router';
import type {Route} from './+types/account.authorize';
import {shopUrl} from '~/lib/catalog-client';
import {portalUrl} from '~/lib/shop-links';

/** Legacy account authorization starts a normal Odoo portal login. */
export function loader({context}: Route.LoaderArgs) {
  throw redirect(portalUrl(shopUrl(context.env), 'login'), 301);
}
