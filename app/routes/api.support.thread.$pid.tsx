import {data} from 'react-router';
import type {Route} from './+types/api.support.thread.$pid';
import {fetchThreadMessages} from '~/lib/support/discord';
import {hasOdooBridge, searchOdooTickets} from '~/lib/support/odoo';
import {readSupportCookie, verifyTicket} from '~/lib/support/session';
import {checkRateLimit} from '~/lib/rate-limit';
import {
  extractFirstName,
  scrubForPublic,
  type PublicMessage,
} from '~/lib/support/scrubber';
import {filterByApproval} from '~/lib/support/moderation';

type ThreadResult =
  | {
      ok: true;
      ticket: {
        pid: string;
        tid: string;
        subject: string;
        status: 'open' | 'closed';
        openedAt: number;
        closedAt: number | null;
      };
      messages: PublicMessage[];
    }
  | {
      ok: false;
      message: string;
      code?: 'signin-required' | 'not-found' | 'no-kv';
    };

const SELF_PREFIX_RE = /^\*\*([^*]{1,80}?):\*\*(?:\s+([\s\S]*))?$/;

// Read-only fetch of a specific ticket the signed-in customer owns.
// Used by /account/support to show closed/non-current threads without
// needing the support cookie. Auth: customer ID must match the ticket
// in the index. Without the ticket store bound we can't verify ownership
// safely, so we 404 in that case rather than risk leaking a thread.
export async function loader({request, context, params}: Route.LoaderArgs) {
  const env = context.env;
  const pid = String(params.pid ?? '').trim();
  if (!/^\d{4,12}$/.test(pid)) {
    return data<ThreadResult>(
      {ok: false, message: 'Invalid ticket id.', code: 'not-found'},
      {status: 400},
    );
  }

  // Identity is the signed ticket cookie, the same proof the
  // resume-by-email link mints. No customer account exists any more.
  const session = await verifyTicket(env, readSupportCookie(request));
  if (!session?.email) {
    return data<ThreadResult>(
      {
        ok: false,
        message: 'Open a ticket, or use the resume link we emailed you.',
        code: 'signin-required',
      },
      {status: 401},
    );
  }
  const email = session.email;

  if (!hasOdooBridge(env)) {
    return data<ThreadResult>(
      {ok: false, message: 'Ticket history unavailable.', code: 'no-kv'},
      {status: 503},
    );
  }

  const limit = checkRateLimit(`support-thread:${email}:${pid}`, 30, 60 * 1000);
  if (!limit.allowed) {
    return data<ThreadResult>(
      {ok: false, message: 'Too many requests.'},
      {status: 429, headers: {'Retry-After': String(limit.resetInSeconds)}},
    );
  }

  // Resolve pid -> tid via Odoo (erp/addons/incutec_support), scoped to
  // this email so a guessed pid can never resolve to another customer's
  // ticket.
  const list = await searchOdooTickets(env, {email, status: 'all', limit: 200});
  const indexEntry = list.find((e) => e.pid === pid);
  if (!indexEntry) {
    return data<ThreadResult>(
      {ok: false, message: 'Ticket not found.', code: 'not-found'},
      {status: 404},
    );
  }

  const {messages, thread} = await fetchThreadMessages(env, indexEntry.tid, {
    limit: 100,
  });
  if (!thread) {
    return data<ThreadResult>(
      {ok: false, message: 'Ticket archived or removed.', code: 'not-found'},
      {status: 410},
    );
  }

  // Same projection rules as /api/support/poll. Customer-relayed
  // bot messages surface as role:'self'; staff surface as helper.
  // Self-relayed bot messages (the customer's own posts) bypass the
  // moderation gate — same reasoning as in /api/support/poll.
  const selfRelayed = messages.filter(
    (m) => m.author.bot && SELF_PREFIX_RE.test(m.content),
  );
  const candidates = messages.filter((m) => !m.author.bot);
  const filtered = await filterByApproval(env, candidates, indexEntry.tid);
  filtered.approved = [...filtered.approved, ...selfRelayed].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const projected: PublicMessage[] = [];
  for (const m of filtered.approved) {
    const isSelf = m.author.bot && SELF_PREFIX_RE.test(m.content);
    if (m.author.bot && !isSelf) continue;
    let raw = m.content;
    let firstName = extractFirstName([m.author.globalName, m.author.username]);
    if (isSelf) {
      const match = SELF_PREFIX_RE.exec(m.content);
      raw = (match?.[2] ?? '').trim();
      firstName = match?.[1]?.trim() || indexEntry.name || 'You';
    }
    const scrubbed = scrubForPublic(raw);
    if (scrubbed.blocked) continue;
    if (!scrubbed.content && !m.attachments.length) continue;
    projected.push({
      id: m.id,
      role: isSelf ? 'self' : 'helper',
      firstName,
      content: scrubbed.content,
      createdAt: m.createdAt,
      attachments: m.attachments.map((a) => ({
        url: a.url,
        filename: a.filename,
      })),
    });
  }

  void request; // satisfy unused-arg lint without changing signature
  return data<ThreadResult>(
    {
      ok: true,
      ticket: {
        pid: indexEntry.pid,
        tid: indexEntry.tid,
        subject: indexEntry.subject,
        status: indexEntry.status,
        openedAt: indexEntry.openedAt,
        closedAt: indexEntry.closedAt,
      },
      messages: projected,
    },
    {headers: {'Cache-Control': 'private, no-store'}},
  );
}
