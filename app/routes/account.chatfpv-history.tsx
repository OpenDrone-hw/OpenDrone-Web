import type {Route} from './+types/account.chatfpv-history';
import {accountsEnabled} from '~/lib/accounts/config';
import {legacyAccountResponse} from '~/lib/accounts/legacy';
import {accountHistory} from '~/lib/accounts/rights';

/** POST /account/chatfpv-history: export or delete the signed-in customer's ChatFPV history (same Origin). */
export function action({request, context}: Route.ActionArgs) {
  return accountHistory(request, context.env);
}

export function loader({context}: Route.LoaderArgs) {
  const {env} = context;
  if (!accountsEnabled(env)) return legacyAccountResponse('chatfpv-history', env);
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST', 'Cache-Control': 'no-store'}});
}
