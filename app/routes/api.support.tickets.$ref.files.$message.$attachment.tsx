import type {Route} from './+types/api.support.tickets.$ref.files.$message.$attachment';
import {ticketRateLimit} from '~/lib/support/limits';
import {authorizedTicket, originOf, supportDeps, supportReady} from '~/lib/support/server';
import {parseTicketRef} from '~/lib/support/tokens';

/**
 * An attachment on the ticket page. Discord's attachment URLs are signed
 * and expire, so this asks Discord for the message again and redirects to
 * the fresh URL. Only for a message stored on this ticket, and only for a
 * browser that may open the ticket.
 */
export async function loader({request, params, context}: Route.LoaderArgs) {
  const env = context.env;
  const ref = parseTicketRef(params.ref);
  const notFound = () => new Response('Not found', {status: 404, headers: {'Cache-Control': 'no-store'}});
  if (!ref || !supportReady(env) || !/^\d{5,25}$/.test(params.message) || !/^\d{5,25}$/.test(params.attachment)) {
    return notFound();
  }
  const deps = supportDeps(env, originOf(request));
  const {ticket} = await authorizedTicket(deps, request, ref);
  if (!ticket) return notFound();
  if (!ticketRateLimit('file', ref).allowed) return new Response('Too many requests', {status: 429});
  const stored = await deps.store.messageByDiscordId(ref, params.message);
  if (!stored || !stored.attachments.some((a) => a.id === params.attachment)) return notFound();
  try {
    const message = await deps.discord.message(ticket.threadId, params.message);
    const file = message.attachments.find((a) => a.id === params.attachment);
    const discordCdn = /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(file?.url ?? '');
    if (!file || !(discordCdn || import.meta.env.DEV)) return notFound();
    return new Response(null, {
      status: 302,
      headers: {Location: file.url, 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer'},
    });
  } catch {
    return notFound();
  }
}
