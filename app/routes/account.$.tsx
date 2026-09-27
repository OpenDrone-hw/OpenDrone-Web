import type {Route} from './+types/account.$';
import {legacyAccountResponse} from '~/lib/accounts/legacy';

/**
 * Legacy account URLs go to the configured Shopify customer account root
 * (app/lib/accounts/legacy.ts). /account/support is the exception: the
 * support desk never belonged to the shop, so it lands on "find my ticket".
 * With ACCOUNTS_ENABLED "1" the specific /account/* routes (login,
 * callback, logout, index) take precedence over this splat.
 */
export function loader({params, context}: Route.LoaderArgs) {
  return legacyAccountResponse(params['*'] ?? '', context.env);
}
