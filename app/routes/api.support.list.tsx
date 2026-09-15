import {data} from 'react-router';
import type {Route} from './+types/api.support.list';
import {readSupportCookie, verifyTicket} from '~/lib/support/session';
import {searchOdooTickets, type OdooTicketStatus} from '~/lib/support/odoo';

type TicketRow = {
  tid: string;
  pid: string;
  subject: string;
  openedAt: number;
  closedAt: number | null;
  lastActivityAt: number;
  status: OdooTicketStatus;
};

type ListResult =
  | {
      ok: true;
      tickets: TicketRow[];
      openCount: number;
    }
  | {ok: false; message: string; code?: 'signin-required'};

// Lists the tickets opened with the email in the signed ticket cookie,
// sourced from Odoo (erp/addons/incutec_support), which replaced this
// storefront's own Upstash-backed ticket index.
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
    | OdooTicketStatus
    | 'all'
    | null;
  const status: OdooTicketStatus | 'all' =
    statusParam === 'open' || statusParam === 'closed' || statusParam === 'all'
      ? statusParam
      : 'all';

  const [tickets, openTickets] = await Promise.all([
    searchOdooTickets(env, {email, status, limit: 50}),
    searchOdooTickets(env, {email, status: 'open', limit: 200}),
  ]);

  return data<ListResult>(
    {
      ok: true,
      tickets: tickets.map((t) => ({
        tid: t.tid,
        pid: t.pid,
        subject: t.subject,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        lastActivityAt: t.lastActivityAt,
        status: t.status,
      })),
      openCount: openTickets.length,
    },
    {headers: {'Cache-Control': 'private, no-store'}},
  );
}
