import type {Route} from './+types/api.support.ask';
import {accountSubFor} from '~/lib/accounts/assertion';
import {handleAsk} from '~/lib/support/chatfpv';

/**
 * POST /api/support/ask: the /support "Ask ChatFPV" box. Same origin only,
 * rate limited per IP, answered by ChatFPV /v1/chat server side. 404 while
 * CHATFPV_ASK_ENABLED is not "1" (app/lib/support/chatfpv.ts `handleAsk`).
 * A signed-in shopper (ACCOUNTS_ENABLED "1") asks as their account:
 * X-ChatFPV-Account carries the pairwise sub.
 */
export async function action({request, context}: Route.ActionArgs) {
  const accountSub = await accountSubFor(request, context.env).catch(() => null);
  return handleAsk(request, context.env, undefined, context.catalog, accountSub);
}

export function loader() {
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
}
