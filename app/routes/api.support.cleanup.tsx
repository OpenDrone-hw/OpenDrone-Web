import {data} from 'react-router';
import type {Route} from './+types/api.support.cleanup';
import {deleteThread, fetchAllThreadMessages} from '~/lib/support/discord';
import {scrubForPublic} from '~/lib/support/scrubber';
import {constantTimeEqual} from '~/lib/support/session';
import {
  archiveTicket,
  getFeedback,
  listAllTickets,
  removeTicket,
  type ArchivedMessage,
} from '~/lib/support/ticket-index';

// Stale-ticket sweeper. Triggered on a daily cron (GitHub Actions →
// curl POST). Walks every ticket meta and deletes the Discord thread +
// index entry for tickets that:
//   - have been closed for at least CLOSED_GRACE_DAYS days. The grace
//     window lets a customer re-open a ticket they accidentally
//     ended via /account/support before the thread is gone for good.
//   - have had no activity for STALE_DAYS days.
//
// Auth: bearer token matching SUPPORT_CLEANUP_SECRET. Without that env
// var set, the endpoint is disabled (503).

const CLOSED_GRACE_DAYS = 1;
const CLOSED_GRACE_SECONDS = CLOSED_GRACE_DAYS * 24 * 60 * 60;
const STALE_DAYS = 7;
const STALE_SECONDS = STALE_DAYS * 24 * 60 * 60;

type CleanupResult =
  | {
      ok: true;
      scanned: number;
      removed: Array<{tid: string; pid: string; reason: 'closed' | 'stale'}>;
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
  // between the public internet and destructive thread+index deletion,
  // so don't leak the secret a byte at a time via `!==` short-circuit.
  if (!constantTimeEqual(auth, `Bearer ${secret}`)) {
    return data<CleanupResult>(
      {ok: false, message: 'Unauthorized.'},
      {status: 401},
    );
  }

  const tickets = await listAllTickets(env);
  const nowSec = Math.floor(Date.now() / 1000);
  const removed: Array<{tid: string; pid: string; reason: 'closed' | 'stale'}> = [];

  for (const meta of tickets) {
    let reason: 'closed' | 'stale' | null = null;
    if (meta.status === 'closed') {
      // closedAt should always be set when status===closed. Fall back
      // to lastActivityAt if it isn't (legacy entries) so we never
      // treat 0 as "closed years ago" and burn through the grace.
      const closedAt = meta.closedAt || meta.lastActivityAt;
      if (closedAt > 0 && nowSec - closedAt >= CLOSED_GRACE_SECONDS) {
        reason = 'closed';
      }
    } else if (
      meta.lastActivityAt > 0 &&
      nowSec - meta.lastActivityAt > STALE_SECONDS
    ) {
      reason = 'stale';
    }
    if (!reason) continue;

    // Archive the conversation + feedback to Upstash (archive:{tid},
    // no TTL) before we tear down Discord + the live index. Failure
    // here is logged but does NOT block deletion — better to lose one
    // archive record than to leave the thread + index growing forever.
    const messages = await fetchAllThreadMessages(env, meta.tid).catch(
      (err) => {
        console.warn(
          '[support/cleanup] fetchAllThreadMessages failed',
          meta.tid,
          err,
        );
        return [];
      },
    );
    const feedback = await getFeedback(env, meta.tid).catch(() => null);
    const archived: ArchivedMessage[] = messages.map((m) => {
      const role: 'staff' | 'customer' | 'bot' = m.author.bot
        ? 'bot'
        : // Customer-side messages are posted by the bot impersonating
          // the customer, so they show up as bot=true here. Staff is
          // any non-bot author. The thread starter (first message,
          // bot=true) is the customer's intake. We don't have a
          // reliable role flag in DiscordMessage, so we fall back to
          // 'bot' for bot-authored and 'staff' for everything else.
          'staff';
      return {
        role,
        authorFirstName: (
          m.author.globalName ||
          m.author.username ||
          ''
        )
          .trim()
          .split(/\s+/)[0]
          ?.slice(0, 40) || 'Unknown',
        content: scrubForPublic(m.content || '').content,
        createdAt: m.createdAt,
      };
    });
    await archiveTicket(env, {
      tid: meta.tid,
      pid: meta.pid,
      subject: meta.subject,
      product: meta.product,
      firmware: meta.firmware,
      openedAt: meta.openedAt,
      closedAt: meta.closedAt ?? 0,
      lastActivityAt: meta.lastActivityAt,
      archivedAt: nowSec,
      removalReason: reason,
      messages: archived,
      feedback,
    }).catch((err) =>
      console.warn('[support/cleanup] archive write failed', meta.tid, err),
    );

    const del = await deleteThread(env, meta.tid).catch((err) => {
      console.warn('[support/cleanup] delete failed', meta.tid, err);
      return {ok: false, status: 0};
    });
    // Even if Discord refuses (rate limit, transient), still drop our
    // index entry so the customer doesn't see a phantom row. The next
    // run will retry the Discord delete with the meta gone (no-op).
    await removeTicket(env, meta.tid).catch((err) =>
      console.warn('[support/cleanup] index remove failed', meta.tid, err),
    );
    removed.push({tid: meta.tid, pid: meta.pid, reason});
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
