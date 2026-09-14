import {data} from 'react-router';
import type {Route} from './+types/api.support.close';
import {fetchAllThreadMessages, postToThread} from '~/lib/support/discord';
import {scrubForPublic} from '~/lib/support/scrubber';
import {
  buildSupportSetCookie,
  readSupportCookie,
  verifyTicket,
} from '~/lib/support/session';
import {
  archiveTicket,
  closeTicket,
  getFeedback,
  getMeta,
  type ArchivedMessage,
} from '~/lib/support/ticket-index';

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
    // Mark closed + post a staff-visible close marker. The Discord
    // thread itself is left in place for a 1-day grace period so the
    // customer can re-open from /account/support if they had buyer's
    // remorse on hitting END TICKET. The daily cleanup cron
    // (/api/support/cleanup) deletes closed threads after 24 h.
    await Promise.all([
      closeTicket(env, ticket.tid).catch((err) =>
        console.warn('[support/close] index update failed', err),
      ),
      postToThread(
        env,
        ticket.tid,
        `_${ticket.name} ended the web-support session._`,
      ).catch(() => null),
    ]);

    // Snapshot the transcript + feedback to archive:{tid} immediately,
    // not at cleanup time. Two reasons:
    //  1. If staff manually delete the Discord thread before the cron
    //     runs (or Discord errors during cleanup's fetch), we still
    //     have the conversation.
    //  2. If the cleanup cron is broken or misconfigured, ended
    //     tickets still land in the corpus.
    // The cleanup pass later overwrites this archive with whatever the
    // thread looks like at deletion time (including any post-close
    // staff notes within the 24h grace). Idempotent.
    //
    // Run in waitUntil so the End-Ticket request returns immediately —
    // a Discord thread fetch + Upstash put adds ~500 ms otherwise.
    const archiveJob = (async () => {
      try {
        const meta = await getMeta(env, ticket.tid);
        if (!meta) return;
        const messages = await fetchAllThreadMessages(env, ticket.tid).catch(
          () => [],
        );
        const feedback = await getFeedback(env, ticket.tid).catch(() => null);
        const archived: ArchivedMessage[] = messages.map((m) => ({
          role: m.author.bot ? 'bot' : 'staff',
          authorFirstName:
            (m.author.globalName || m.author.username || '')
              .trim()
              .split(/\s+/)[0]
              ?.slice(0, 40) || 'Unknown',
          content: scrubForPublic(m.content || '').content,
          createdAt: m.createdAt,
        }));
        await archiveTicket(env, {
          tid: meta.tid,
          pid: meta.pid,
          subject: meta.subject,
          product: meta.product,
          firmware: meta.firmware,
          openedAt: meta.openedAt,
          closedAt: meta.closedAt ?? Math.floor(Date.now() / 1000),
          lastActivityAt: meta.lastActivityAt,
          archivedAt: Math.floor(Date.now() / 1000),
          removalReason: 'closed',
          messages: archived,
          feedback,
        });
      } catch (err) {
        console.warn('[support/close] archive snapshot failed', err);
      }
    })();
    if (context.waitUntil) {
      context.waitUntil(archiveJob);
    } else {
      void archiveJob;
    }
  }
  return data<CloseResult>(
    {ok: true},
    {headers: {'Set-Cookie': buildSupportSetCookie('', {clear: true})}},
  );
}

export function loader() {
  return new Response(null, {status: 404});
}
