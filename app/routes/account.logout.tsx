import type {Route} from './+types/account.logout';
import {accountsEnabled, notFound} from '~/lib/accounts/config';
import {identityProvider} from '~/lib/accounts/idp';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {logout} from '~/lib/accounts/signin';

/** POST /account/logout (same Origin): revoke, tell ChatFPV, end the Shopify session. */
export function action({request, context}: Route.ActionArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return notFound();
  return logout(request, env, identityProvider(env, request));
}

export function loader({context}: Route.LoaderArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('logout', env);
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST', 'Cache-Control': 'no-store'}});
}
