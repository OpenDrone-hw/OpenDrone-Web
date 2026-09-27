import type {Route} from './+types/api.support.ask.stream';
import {accountSubFor} from '~/lib/accounts/assertion';
import {handleAskStream} from '~/lib/support/chatfpv';

/**
 * POST /api/support/ask/stream: the streaming build of the /support "Ask
 * ChatFPV" box. Same origin, rate limit and validation as
 * `/api/support/ask`; a fixed-rule/preorder answer or an early refusal is
 * plain JSON exactly like that route. Once ChatFPV itself starts
 * answering, the response becomes `text/event-stream` (`delta` chunks of
 * the already-computed answer text, one final `done` with the same
 * `AskResult` shape `/api/support/ask` returns whole). 404 while
 * CHATFPV_ASK_ENABLED is not "1" (app/lib/support/chatfpv.ts `handleAsk`).
 */
export async function action({request, context}: Route.ActionArgs) {
  const accountSub = await accountSubFor(request, context.env).catch(() => null);
  return handleAskStream(request, context.env, undefined, context.catalog, context.waitUntil, accountSub);
}

export function loader() {
  return new Response('Method Not Allowed', {status: 405, headers: {Allow: 'POST'}});
}
