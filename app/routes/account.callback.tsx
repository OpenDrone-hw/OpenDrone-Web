import type {Route} from './+types/account.callback';
import {accountsEnabled} from '~/lib/accounts/config';
import {identityProvider} from '~/lib/accounts/idp';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {finishLogin} from '~/lib/accounts/signin';

/** GET /account/callback?code&state: finish sign-in, set __Host-od_sid. Legacy redirect while ACCOUNTS_ENABLED is off. */
export function loader({request, context}: Route.LoaderArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('callback', env);
  return finishLogin(request, env, identityProvider(env, request));
}
