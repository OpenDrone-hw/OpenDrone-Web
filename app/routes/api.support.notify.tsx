import {data} from 'react-router';
import type {Route} from './+types/api.support.notify';
import {
  fetchThreadMessages,
  firstNameOnly,
  postToThread,
} from '~/lib/support/discord';
import {sendReplyNotification} from '~/lib/support/email';
import {buildResumeUrl, signResumeToken} from '~/lib/support/resume-token';
import {constantTimeEqual, randomId} from '~/lib/support/session';
import {filterByApproval} from '~/lib/support/moderation';
import {extractFirstName, scrubForPublic} from '~/lib/support/scrubber';
import {
  hasTicketStore,
  listAllTickets,
  patchMeta,
} from '~/lib/support/ticket-index';
import {
  decideNotify,
  laterSnowflake,
  type SweepMessage,
} from '~/lib/support/notify-decision';
import {flushOdooMirror} from '~/lib/support/odoo';

// Reply-notification sweep. Triggered every 15 minutes by
// .github/workflows/support-notify.yml. For every open ticket it looks
// at the Discord messages the customer has neither seen in the widget
// (seenCursor, written by /api/support/poll while the tab is visible)
// nor been emailed about (notifyCursor), and sends ONE batched email
// per ticket once the newest staff reply has settled for 10+ minutes
// (decideNotify owns that logic). After a successful send the bot
// posts a confirmation into the thread so staff can see the customer
// was notified; that bot message never surfaces to the widget.
//
// Moderation is respected: in enforce mode only ✅-approved replies are
// emailed, and the cursor never advances past a held reply, so a late
// approval still gets emailed on a later sweep.
//
// Auth: bearer token matching SUPPORT_CLEANUP_SECRET (same secret as
// the cleanup sweep). Without the env var the endpoint is disabled.

const SELF_PREFIX_RE = /^\*\*([^*]{1,80}?):\*\*(?:\s+([\s\S]*))?$/;
const MAX_TICKETS_PER_RUN = 200;

type NotifyResult =
  | {
      ok: true;
      scanned: number;
      emailed: Array<{tid: string; pid: string; replies: number}>;
      deferred: number;
    }
  | {ok: false; message: string};

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<NotifyResult>(
      {ok: false, message: 'Method not allowed.'},
      {status: 405},
    );
  }
  const env = context.env;
  const secret = env.SUPPORT_CLEANUP_SECRET;
  if (!secret) {
    return data<NotifyResult>(
      {ok: false, message: 'Notify endpoint not configured.'},
      {status: 503},
    );
  }
  const auth = request.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token || !constantTimeEqual(token, secret)) {
    return data<NotifyResult>(
      {ok: false, message: 'Unauthorized.'},
      {status: 401},
    );
  }
  if (!hasTicketStore(env)) {
    return data<NotifyResult>(
      {ok: false, message: 'Ticket store not configured.'},
      {status: 503},
    );
  }

  const origin = new URL(request.url).origin;
  const nowMs = Date.now();
  const all = await listAllTickets(env);
  const open = all
    .filter((t) => t.status === 'open')
    .slice(0, MAX_TICKETS_PER_RUN);

  const emailed: Array<{tid: string; pid: string; replies: number}> = [];
  let deferred = 0;

  // Sequential on purpose: open-ticket volume is tiny and this keeps
  // the Discord/Resend call pattern trivially rate-limit safe.
  for (const ticket of open) {
    try {
      if (ticket.odooPending?.length || !ticket.odooRef) {
        await flushOdooMirror(env, ticket);
      }
      const after = laterSnowflake(ticket.notifyCursor, ticket.seenCursor);
      const {messages, thread} = await fetchThreadMessages(env, ticket.tid, {
        afterId: after,
        limit: 50,
      });
      // Archived/deleted threads are the cleanup sweep's problem.
      if (!thread || !messages.length) continue;

      const candidates = messages.filter((m) => !m.author.bot);
      const filtered = await filterByApproval(env, candidates, ticket.tid);
      const heldIds =
        filtered.mode === 'enforce'
          ? new Set(filtered.dropped.map((d) => d.message.id))
          : new Set<string>();
      const approvedIds = new Set(filtered.approved.map((m) => m.id));

      const sweep: SweepMessage[] = messages.map((m) => {
        let staff = false;
        let content = '';
        if (!m.author.bot && approvedIds.has(m.id)) {
          const scrubbed = scrubForPublic(m.content);
          if (!scrubbed.blocked && scrubbed.content) {
            staff = true;
            content = scrubbed.content;
          }
        }
        return {
          id: m.id,
          staff,
          customer: m.author.bot && SELF_PREFIX_RE.test(m.content),
          held: heldIds.has(m.id),
          createdAtMs: Date.parse(m.createdAt) || 0,
          firstName: extractFirstName([m.author.globalName, m.author.username]),
          content,
        };
      });

      const decision = decideNotify(sweep, nowMs);
      if (decision.action === 'defer') {
        deferred++;
        continue;
      }
      if (decision.action === 'skip') {
        if (decision.nextCursor) {
          await patchMeta(env, ticket.tid, {notifyCursor: decision.nextCursor});
        }
        continue;
      }

      if (!ticket.email) {
        // Nothing to email; settle the cursor so we stop re-reading.
        await patchMeta(env, ticket.tid, {notifyCursor: decision.nextCursor});
        continue;
      }
      const resumeToken = await signResumeToken(env, {
        tid: ticket.tid,
        uid: randomId(),
        email: ticket.email,
        name: ticket.name,
        pid: ticket.pid,
      });
      const sent = await sendReplyNotification(env, {
        to: ticket.email,
        name: ticket.name,
        subject: ticket.subject || 'Your support ticket',
        resumeUrl: buildResumeUrl(origin, resumeToken),
        replies: decision.include.map((m) => ({
          staffFirstName: m.firstName,
          preview: m.content,
        })),
      });
      // Send failed (Resend unset/down): no cursor advance, the same
      // batch is retried on the next sweep.
      if (!sent) continue;

      await patchMeta(env, ticket.tid, {notifyCursor: decision.nextCursor});
      emailed.push({
        tid: ticket.tid,
        pid: ticket.pid,
        replies: decision.include.length,
      });
      const n = decision.include.length;
      await postToThread(
        env,
        ticket.tid,
        `📧 Emailed ${firstNameOnly(ticket.name)} a reply notification (${n} ${n === 1 ? 'reply' : 'replies'} included).`,
      );
    } catch (err) {
      console.warn(
        '[support/notify] ticket failed',
        ticket.tid,
        err instanceof Error ? err.name : 'unknown',
      );
    }
  }

  return data<NotifyResult>(
    {ok: true, scanned: open.length, emailed, deferred},
    {headers: {'Cache-Control': 'no-store'}},
  );
}
