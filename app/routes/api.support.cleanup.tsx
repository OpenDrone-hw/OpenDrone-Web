import {data} from 'react-router';
import type {Route} from './+types/api.support.cleanup';
import {deleteThread} from '~/lib/support/discord';
import {constantTimeEqual} from '~/lib/support/session';
import {patchOdooTicketState, searchOdooTickets} from '~/lib/support/odoo';

// Stale-ticket sweeper. Triggered on a daily cron (GitHub Actions →
// curl POST). Walks every ticket and deletes the Discord thread for
// tickets that:
//   - have been closed for at least CLOSED_GRACE_DAYS days. The grace
//     window lets a customer re-open a ticket they accidentally
//     ended via /account/support before the thread is gone for good.
//   - have had no activity for STALE_DAYS days.
//
// No separate archive step: every message either side sends is already
// mirrored into the Odoo task's chatter as it happens
// (api.support.start.tsx, api.support.send.tsx), so that task is the
// permanent record already — this route's only remaining job is to tear
// down the Discord thread and mark the ticket `thread_deleted` so it
// drops out of future searches/sweeps.
//
// Auth: bearer token matching SUPPORT_CLEANUP_SECRET. Without that env
// var set, the endpoint is disabled (503).

const CLOSED_GRACE_DAYS = 1;
const CLOSED_GRACE_SECONDS = CLOSED_GRACE_DAYS * 24 * 60 * 60;
const STALE_DAYS = 7;
const STALE_SECONDS = STALE_DAYS * 24 * 60 * 60;
const MAX_TICKETS_PER_RUN = 500;

type CleanupResult =
  | {
      ok: true;
      scanned: number;
      removed: Array<{tid: string; ref: string; reason: 'closed' | 'stale'}>;
    }
  | {ok: false; message: string};

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<CleanupResult>(
      {ok: false, message: 'Method not allowed.'},
      {status: 405},
    );
  }
  const env = context.env;
  const secret = env.SUPPORT_CLEANUP_SECRET;
  if (!secret) {
    return data<CleanupResult>(
      {ok: false, message: 'Cleanup endpoint not configured.'},
      {status: 503},
    );
  }
  const auth = request.headers.get('authorization') ?? '';
  // Constant-time compare — this bearer gate is the only thing standing
  // between the public internet and destructive thread deletion, so
  // don't leak the secret a byte at a time via `!==` short-circuit.
  if (!constantTimeEqual(auth, `Bearer ${secret}`)) {
    return data<CleanupResult>(
      {ok: false, message: 'Unauthorized.'},
      {status: 401},
    );
  }

  const tickets = await searchOdooTickets(env, {status: 'all', limit: MAX_TICKETS_PER_RUN});
  const nowSec = Math.floor(Date.now() / 1000);
  const removed: Array<{tid: string; ref: string; reason: 'closed' | 'stale'}> = [];

  for (const ticket of tickets) {
    let reason: 'closed' | 'stale' | null = null;
    if (ticket.status === 'closed') {
      // closedAt should always be set when status===closed. Fall back
      // to lastActivityAt if it isn't (legacy entries) so we never
      // treat 0 as "closed years ago" and burn through the grace.
      const closedAt = ticket.closedAt || ticket.lastActivityAt;
      if (closedAt > 0 && nowSec - closedAt >= CLOSED_GRACE_SECONDS) {
        reason = 'closed';
      }
    } else if (
      ticket.lastActivityAt > 0 &&
      nowSec - ticket.lastActivityAt > STALE_SECONDS
    ) {
      reason = 'stale';
    }
    if (!reason) continue;

    const del = await deleteThread(env, ticket.tid).catch((err) => {
      console.warn('[support/cleanup] delete failed', ticket.tid, err);
      return {ok: false, status: 0};
    });
    // Even if Discord refuses (rate limit, transient), still mark the
    // ticket thread-deleted so it stops recurring in this sweep and the
    // notify sweep. The Odoo task (with its full mirrored chatter) stays
    // as the permanent record either way.
    await patchOdooTicketState(env, ticket.ref, {threadDeleted: true}).catch((err) =>
      console.warn('[support/cleanup] thread_deleted patch failed', ticket.tid, err),
    );
    removed.push({tid: ticket.tid, ref: ticket.ref, reason});
    void del;
  }

  return data<CleanupResult>(
    {ok: true, scanned: tickets.length, removed},
    {headers: {'Cache-Control': 'no-store'}},
  );
}

export function loader() {
  return new Response(null, {status: 404});
}
