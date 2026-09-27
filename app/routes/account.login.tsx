import type {Route} from './+types/account.login';
import {accountsEnabled} from '~/lib/accounts/config';
import {identityProvider} from '~/lib/accounts/idp';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {startLogin} from '~/lib/accounts/signin';

/** GET /account/login?return_to=<path>: start Shopify (or test IdP) sign-in. Legacy redirect while ACCOUNTS_ENABLED is off. */
export function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('login', env);
  return startLogin(request, env, identityProvider(env, request));
}
