import type {Route} from './+types/api.support.tickets.$ref';
import {ticketRateLimit} from '~/lib/support/limits';
import {authorizedTicket, originOf, supportDeps, supportReady} from '~/lib/support/server';
import {publicMessage, syncTicket} from '~/lib/support/tickets';
import {parseTicketRef} from '~/lib/support/tokens';
import {handleTicketAction, jsonOutcome} from '~/lib/support/handlers';

/**
 * POST /api/support/tickets/<ref>: the ticket page's reply, solve and
 * replace-link with JavaScript, as JSON (the page's own action without it).
 *
 * GET /api/support/tickets/<ref>?after=<seq>: the ticket page's refresh.
 * Reads the Discord thread (throttled per ticket), then answers with the
 * status and the messages after `after`. Cookie-authorised like the page.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex'},
  });

export async function loader({request, params, context}: Route.LoaderArgs) {
  const env = context.env;
  const ref = parseTicketRef(params.ref);
  if (!ref || !supportReady(env)) return json({ok: false}, 404);
  const deps = supportDeps(env, originOf(request), context.waitUntil);
  const {ticket} = await authorizedTicket(deps, request, ref);
  if (!ticket) return json({ok: false}, 401);
  // After authorisation: a stranger polling this ref cannot use up its owner's allowance.
  if (!ticketRateLimit('poll', ref).allowed) return json({ok: false}, 429);
  const after = Math.max(0, Number(new URL(request.url).searchParams.get('after')) || 0);
  const {ticket: synced} = await syncTicket(deps, ticket);
  // The page only asks while it is visible, so an answer means seen.
  await deps.store.updateTicket(ref, {customerSeenAt: Date.now()});
  const messages = await deps.store.messages(ref, after, 100);
  return json({ok: true, status: synced.status, locked: synced.locked, messages: messages.map(publicMessage)});
}

export async function action({request, params, context}: Route.ActionArgs) {
  return jsonOutcome(await handleTicketAction(request, context, params.ref));
}
