import {data} from 'react-router';
import type {Route} from './+types/api.support.list';
import {readSupportCookie, verifyTicket} from '~/lib/support/session';
import {
  countOpenForEmail,
  listByEmail,
  type TicketIndexEntry,
  type TicketStatus,
} from '~/lib/support/ticket-index';

type ListResult =
  | {
      ok: true;
      tickets: TicketIndexEntry[];
      openCount: number;
    }
  | {ok: false; message: string; code?: 'signin-required'};

// Lists the tickets opened with the email in the signed ticket cookie.
// KV-fast: one indexed read per call. Falls back to an empty list when
// the Upstash store is unbound (tickets still exist in Discord; staff can
// find them via the forum, the customer-facing /support/tickets view just
// won't list them until storage is provisioned).
export async function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;

  // Identity is the signed ticket cookie: the email the visitor opened a
  // ticket with. There is no customer account to read any more, and the
  // cookie is the same proof the resume-by-email link mints.
  const ticket = await verifyTicket(env, readSupportCookie(request));
  if (!ticket?.email) {
    return data<ListResult>(
      {
        ok: false,
        message: 'Open a ticket, or use the resume link we emailed you.',
        code: 'signin-required',
      },
      {status: 401, headers: {'Cache-Control': 'no-store'}},
    );
  }
  const email = ticket.email;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status') as
    | TicketStatus
    | 'all'
    | null;
  const status: TicketStatus | 'all' =
    statusParam === 'open' || statusParam === 'closed' || statusParam === 'all'
      ? statusParam
      : 'all';

  const [tickets, openCount] = await Promise.all([
    listByEmail(env, email, {status, limit: 50}),
    countOpenForEmail(env, email),
  ]);

  return data<ListResult>(
    {ok: true, tickets, openCount},
    {headers: {'Cache-Control': 'private, no-store'}},
  );
}
