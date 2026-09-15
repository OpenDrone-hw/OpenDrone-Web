import {data} from 'react-router';
import type {Route} from './+types/api.support.close';
import {postToThread} from '~/lib/support/discord';
import {
  buildSupportSetCookie,
  readSupportCookie,
  verifyTicket,
} from '~/lib/support/session';
import {createOrFetchOdooTicket, patchOdooTicketState} from '~/lib/support/odoo';

type CloseResult = {ok: true} | {ok: false; message: string};

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<CloseResult>(
      {ok: false, message: 'Method not allowed.'},
      {status: 405},
    );
  }
  const env = context.env;
  const cookie = readSupportCookie(request);
  const ticket = await verifyTicket(env, cookie);
  if (ticket) {
    // Mark closed on the mirrored Odoo ticket + post a staff-visible close
    // marker. The Discord thread itself is left in place for a 1-day grace
    // period so the customer can re-open from /account/support if they had
    // buyer's remorse on hitting END TICKET. The daily cleanup cron
    // (/api/support/cleanup) deletes closed threads after 24 h.
    //
    // No separate archive snapshot any more: every message either side
    // sends is already mirrored into the Odoo task's chatter as it
    // happens (app/routes/api.support.start.tsx, api.support.send.tsx),
    // so that task IS the permanent record once the Discord thread is
    // gone — there is nothing left for this route to additionally save.
    const closeJob = (async () => {
      const odooTicket = await createOrFetchOdooTicket(env, {
        threadId: ticket.tid,
        email: ticket.email,
        name: ticket.name,
        subject: `Support ticket #${ticket.pid ?? ticket.uid}`,
      });
      if (odooTicket) {
        await patchOdooTicketState(env, odooTicket.ticketRef, {closed: true});
      }
    })().catch((err) => console.warn('[support/close] odoo close failed', err));
    // Odoo's own round trip (up to ~10s with its one retry) must never
    // tail this response — fire-and-forget like every other Odoo call
    // (D13). The Discord close marker is fast enough to await directly.
    if (context.waitUntil) context.waitUntil(closeJob);
    else void closeJob;
    await postToThread(
      env,
      ticket.tid,
      `_${ticket.name} ended the web-support session._`,
    ).catch(() => null);
  }
  return data<CloseResult>(
    {ok: true},
    {headers: {'Set-Cookie': buildSupportSetCookie('', {clear: true})}},
  );
}

export function loader() {
  return new Response(null, {status: 404});
}
