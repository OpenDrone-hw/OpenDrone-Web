import type {Route} from './+types/account.chatfpv-history';
import {accountsEnabled} from '~/lib/accounts/config';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {accountHistory} from '~/lib/accounts/rights';
import {appAccountsEnabled} from '~/lib/commerce/app-account';
import {appHistory} from '~/lib/commerce/app-chatfpv';

/** POST /account/chatfpv-history: export or delete the signed-in customer's ChatFPV history (same Origin). */
export function action({request, context}: Route.ActionArgs) {
  if (appAccountsEnabled(context.env)) return appHistory(request, context.env);
  return accountHistory(request, context.env);
}

export function loader({context}: Route.LoaderArgs) {
  const {env} = context;
  if (appAccountsEnabled(env)) return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST', 'Cache-Control': 'no-store'}});
  if (!accountsEnabled(env)) return legacyAccountResponse('chatfpv-history', env);
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST', 'Cache-Control': 'no-store'}});
}
