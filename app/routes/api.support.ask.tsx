import type {Route} from './+types/api.support.ask';
import {handleAsk} from '~/lib/support/chatfpv';

/**
 * POST /api/support/ask: the /support "Ask ChatFPV" box. Same origin only,
 * rate limited per IP, answered by ChatFPV /v1/chat server side. 404 while
 * CHATFPV_ASK_ENABLED is not "1" (app/lib/support/chatfpv.ts `handleAsk`).
 */
export async function action({request, context}: Route.ActionArgs) {
  return handleAsk(request, context.env);
}

export function loader() {
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
}
