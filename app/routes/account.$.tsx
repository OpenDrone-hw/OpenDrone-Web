import {redirect} from 'react-router';
import type {Route} from './+types/account.$';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {appCommerceEnabled} from '~/lib/commerce/app-api';

/**
 * Legacy account URLs go to the configured Shopify customer account root
 * (app/lib/accounts/legacy.ts). /account/support is the exception: the
 * support desk never belonged to the shop, so it lands on "find my ticket".
 * With ACCOUNTS_ENABLED "1" the specific /account/* routes (login,
 * callback, logout, index) take precedence over this splat.
 *
 * App mode (COMMERCE_SOURCE=app): Shopify's customer account is gone, so an old
 * /account/orders[/<id>] link goes to the order lookup and every other old
 * /account/* path (register, reset, activate) to the account page.
 */
export function loader({params, context}: Route.LoaderArgs) {
  const rest = (params['*'] ?? '').replace(/^\/+/, '');
  if (appCommerceEnabled(context.env) && !/^support(\/|$)/.test(rest)) {
    throw redirect(/^orders(\/|$)/.test(rest) ? '/shop/order' : '/account', 301);
  }
  return legacyAccountResponse(params['*'] ?? '', context.env);
}
