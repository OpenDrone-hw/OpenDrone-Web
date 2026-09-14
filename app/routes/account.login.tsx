import {redirect} from 'react-router';
import type {Route} from './+types/account.login';
import {shopUrl} from '~/lib/catalog-client';
import {portalUrl} from '~/lib/shop-links';

export function loader({context}: Route.LoaderArgs) {
  throw redirect(portalUrl(shopUrl(context.env), 'login'), 301);
}
