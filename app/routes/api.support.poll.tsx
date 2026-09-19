import {data} from 'react-router';
import type {Route} from './+types/api.support.poll';
import {fetchThreadMessages} from '~/lib/support/discord';
import {
  buildSupportSetCookie,
  readSupportCookie,
  signTicket,
  verifyTicket,
} from '~/lib/support/session';
import {checkRateLimit} from '~/lib/rate-limit';
import {createOrFetchOdooTicket, patchOdooTicketState} from '~/lib/support/odoo';
import {
  extractFirstName,
  scrubForPublic,
  type PublicMessage,
} from '~/lib/support/scrubber';
import {filterByApproval} from '~/lib/support/moderation';
import {computeCursorTarget} from '~/lib/support/poll-cursor';

// Trust boundary between Discord and the customer's browser.
//
// Every Discord message passes through scrubForPublic() before it lands
// in the response. The browser only sees:
//   - a first name (safe because Discord display names are public),
//   - a role flag (helper | self),
//   - scrubbed content,
//   - attachments already filtered at upload time.
//
// Everything else in the raw Discord payload (author.id, avatar hash,
// discriminator, global_name, guild_id, roles, embeds, components, …)
// is dropped here and never reaches JSON.stringify.

export type PollStats = {
  // Helper-authored messages delivered in this poll (post-moderation,
  // post-scrubber). Informational - the widget derives its live visible
  // count from the message list.
  deltaVisible: number;
  // SNAPSHOT of helper-authored messages currently held by the
  // moderation gate (enforce mode only). Surfaced as "X awaiting
  // confirmation"; the widget assigns this directly each poll, so it
  // falls back to zero as soon as a moderator approves the held replies.
  pending: number;
};

type PollResult =
  | {
      ok: true;
      messages: PublicMessage[];
      closed: boolean;
      stats: PollStats;
    }
  | {ok: false; message: string; code?: 'no-ticket' | 'thread-gone'};

export async function loader({request, context}: Route.LoaderArgs) {
  const env = context.env;
  const cookie = readSupportCookie(request);
  const ticket = await verifyTicket(env, cookie);

  if (!ticket) {
    return data<PollResult>(
      {ok: false, message: 'No active ticket.', code: 'no-ticket'},
      {status: 401},
    );
  }

  // Per-ticket poll cap. Widget polls every 4s active / 15s hidden, so
  // 30/min leaves a large margin; anything more is automation.
  const limit = checkRateLimit(`support-poll:${ticket.uid}`, 30, 60 * 1000);
  if (!limit.allowed) {
    return data<PollResult>(
      {ok: false, message: 'Polling too fast.'},
      {
        status: 429,
        headers: {
          'Retry-After': String(limit.resetInSeconds),
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  const url = new URL(request.url);
  // `?initial=1` ignores the cookie cursor so a returning/refreshed user
  // gets the recent thread history instead of just messages newer than
  // whatever the previous session last delivered.
  //
  // We intentionally do NOT honour an `?after=` query param: the cookie
  // cursor is the only authoritative forward-only position. Accepting a
  // client-supplied cursor would let a ticket holder rewind to re-read
  // older messages (e.g. contents they hoped were ephemeral) and replay
  // staff replies, so the cursor stays server-side.
  const initial = url.searchParams.get('initial') === '1';
  // `visible=0` marks a poll from a hidden/backgrounded tab. Delivering
  // to a hidden tab must not count as the customer having SEEN the
  // reply, or the notify sweep would skip its email. Client-controlled,
  // but the stakes are one redundant (or one missing) courtesy email.
  // Absent param (older cached widget bundles) counts as visible.
  const visible = url.searchParams.get('visible') !== '0';
  const after = initial ? undefined : ticket.lastCursor || undefined;

  const {messages, thread} = await fetchThreadMessages(env, ticket.tid, {
    afterId: after,
    limit: 50,
  });

  if (!thread) {
    return data<PollResult>(
      {ok: false, message: 'Ticket thread not found.', code: 'thread-gone'},
      {status: 410},
    );
  }

  // Moderation gate (Stage 2). Filter to approved messages before we
  // project into the public shape. Dropped messages are logged (reason
  // only, never content) so staff can watch the gate when tuning it.
  //
  // Bot authorship rules:
  //   - Bot messages that start with `**<Name>:**` are customer-relayed
  //     messages from /api/support/send. Project as role:'self' so the
  //     customer sees their own history on refresh - without these the
  //     log appears empty until staff replies.
  //   - Every other bot message is the thread-starter or a system
  //     message and must not surface.
  // Self-relayed messages bypass the moderation gate - the customer
  // wrote them, so requiring a staff ✅ to surface them on refresh
  // would erase the customer's own history.
  const selfRelayed = messages.filter(
    (m) => m.author.bot && isSelfRelayedMessage(m.content),
  );
  const candidates = messages.filter((m) => !m.author.bot);
  const filtered = await filterByApproval(env, candidates, ticket.tid);
  // Re-merge self-relayed back into approved, preserving Discord's
  // chronological order (messages come back oldest→newest).
  filtered.approved = [...filtered.approved, ...selfRelayed].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  if (filtered.dropped.length > 0) {
    console.warn(
      '[support] moderation',
      filtered.mode,
      'dropped',
      filtered.dropped.length,
      filtered.dropped.map((d) => `${d.message.id}:${d.reason}`).join(','),
    );
  }

  // Project each raw Discord message into the public shape. A projection
  // that returns null (blocked by the scrubber, or empty after redaction)
  // is dropped from the response but still advances the cursor - otherwise
  // a single always-blocked message would loop forever.
  const projected: PublicMessage[] = [];
  for (const m of filtered.approved) {
    const isSelfRelayed = m.author.bot && isSelfRelayedMessage(m.content);
    if (m.author.bot && !isSelfRelayed) continue;
    // Strip the bot marker from content before scrubbing/projecting -
    // the `role` field replaces the inline prefix in the widget.
    let rawContent = m.content;
    let projectedFirstName = extractFirstName([
      m.author.globalName,
      m.author.username,
    ]);
    if (isSelfRelayed) {
      const stripped = stripSelfPrefix(m.content);
      rawContent = stripped.body;
      projectedFirstName = stripped.firstName || ticket.name;
    }
    const scrubbed = scrubForPublic(rawContent);
    if (scrubbed.blocked) {
      // Log the redaction reasons at warn level so staff can see the
      // Stage-2 moderation UI (once built) surface "this draft was
      // blocked by the scrubber" cleanly. Never log the raw content.
      console.warn(
        '[support] scrubber blocked message',
        m.id,
        scrubbed.reasons.join(','),
      );
      continue;
    }
    if (!scrubbed.content && !m.attachments.length) continue;
    projected.push({
      id: m.id,
      role: isSelfRelayed ? 'self' : 'helper',
      firstName: projectedFirstName,
      content: scrubbed.content,
      createdAt: m.createdAt,
      attachments: m.attachments.map((a) => ({
        url: a.url,
        filename: a.filename,
      })),
    });
  }

  // Only enforce-mode drops are "held": in log/off mode the dropped set
  // is still delivered, so those messages are terminal and the cursor
  // may pass them. Scrubber-blocked and bot system messages (dropped in
  // the projection loop above, not in filtered.dropped) are terminal too
  // - they never change - so they don't pin the cursor either.
  const heldIds =
    filtered.mode === 'enforce'
      ? new Set(filtered.dropped.map((d) => d.message.id))
      : new Set<string>();
  const cursorTarget = computeCursorTarget(
    messages,
    heldIds,
    ticket.lastCursor,
  );

  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
  };

  // Roll the cursor forward into the signed cookie so the next poll asks
  // only for what's newer than what we just delivered - but never past a
  // message still awaiting moderation (see cursorTarget above).
  const cursorChanged = cursorTarget && cursorTarget !== ticket.lastCursor;
  if (cursorChanged) {
    const rolled = {...ticket, lastCursor: cursorTarget};
    headers['Set-Cookie'] = buildSupportSetCookie(await signTicket(env, rolled));
  }

  // Record what the customer has seen so the notify sweep
  // (/api/support/notify) doesn't email them about replies they already
  // watched arrive live. Only polls from a visible tab count, and only
  // when the cursor actually moved: a hidden tab keeps polling at 15s
  // but its deliveries stay email-eligible. Best-effort, never blocks
  // the response.
  if (visible && cursorChanged && cursorTarget) {
    const job = (async () => {
      const odooTicket = await createOrFetchOdooTicket(env, {
        threadId: ticket.tid,
        email: ticket.email,
        name: ticket.name,
        subject: `Support ticket #${ticket.pid ?? ticket.uid}`,
      });
      if (!odooTicket) return;
      await patchOdooTicketState(env, odooTicket.ticketRef, {seenCursor: cursorTarget});
    })().catch((err) => console.warn('[support/poll] seenCursor write failed', err));
    if (context.waitUntil) context.waitUntil(job);
    else void job;
  }

  // Stats for the sidebar.
  //   deltaVisible - scrubber-passed helper messages delivered this poll
  //     (a delta; the widget derives the live "visible" count from the
  //     message list itself, so this is informational).
  //   pending - a SNAPSHOT of how many helper messages are currently held
  //     by the moderation gate. Because the cursor now parks behind held
  //     messages, the same pending message recurs in every poll window
  //     until it's approved; an accumulating delta would inflate without
  //     bound and never decrement. A snapshot the widget assigns directly
  //     rises when a reply is held and falls to zero the moment a
  //     moderator ✅'s it. Only enforce mode genuinely holds messages - in
  //     log/off mode the "dropped" set is still delivered, so nothing is
  //     pending.
  const deltaVisible = projected.filter((m) => m.role === 'helper').length;
  const pending =
    filtered.mode === 'enforce'
      ? filtered.dropped.filter((d) => !d.message.author.bot).length
      : 0;

  return data<PollResult>(
    {
      ok: true,
      messages: projected,
      closed: thread.archived || thread.locked,
      stats: {deltaVisible, pending},
    },
    {headers},
  );
}

// Recognises a customer-relayed message posted by the bot on behalf of
// the customer. Format from /api/support/send: `**<First>:**` optionally
// followed by a space + body. Conservative - caps the captured name at
// 80 chars and disallows asterisks in the name to avoid matching bold
// runs in arbitrary helper replies.
const SELF_PREFIX_RE = /^\*\*([^*]{1,80}?):\*\*(?:\s+([\s\S]*))?$/;

function isSelfRelayedMessage(content: string): boolean {
  return SELF_PREFIX_RE.test(content);
}

function stripSelfPrefix(content: string): {
  firstName: string;
  body: string;
} {
  const match = SELF_PREFIX_RE.exec(content);
  if (!match) return {firstName: '', body: content};
  return {firstName: match[1].trim(), body: (match[2] ?? '').trim()};
}
