/**
 * Customer mail into the ticket queue (README "Support tickets", "Mail").
 *
 * Every cron pass (server.ts `scheduled`, behind SUPPORT_MAIL_INTAKE_ENABLED)
 * asks Gmail for the last few days of mail sent to the customer addresses,
 * drops everything that is not a customer (mail-parse.ts `classify`), and
 * turns the rest into tickets exactly like the web form does: a Discord
 * thread with the staff card, the ChatFPV draft, the Shopify match only
 * through an order number Shopify confirms for the sender. A follow-up mail
 * (the ticket reference in the subject, or the Gmail thread of an earlier
 * mail of the same sender) is copied into that ticket as a customer reply.
 *
 * Nothing is mailed by this module. The customer gets the ticket link
 * through the existing "new reply" notice when staff answer.
 *
 * Modes (SUPPORT_MAIL_INTAKE_ENABLED): anything but "1" or "dry" is off;
 * "dry" fetches and classifies and only reports counts, writing nothing.
 *
 * Idempotency: a row per message in support_mail_messages, keyed by the
 * SHA-256 of the Message-ID header, claimed before the work starts. A
 * failure marks the row "retry" (3 attempts). The one remaining window is a
 * Worker killed between creating a ticket and recording it, which would
 * open that ticket twice on the retry.
 */
import {cleanText, escapeDiscord} from './discord.ts';
import {createGmailClient, gmailConfigured, type GmailClient, type GmailEnv} from './mail-gmail.ts';
import {
  DEFAULT_OWN_DOMAINS,
  bodyText,
  classify,
  cleanSubject,
  displayName,
  guessTopic,
  headerOf,
  listConfig,
  orderNumberIn,
  refInSubject,
  type MailConfig,
  type MailMessage,
} from './mail-parse.ts';
import {scrubForDiscord} from './scrubber.ts';
import {LIMITS, addCustomerReply, createTicket, type Deps, type NewTicketInput} from './tickets.ts';

export type MailEnv = GmailEnv & {
  /** "1" on, "dry" report only, anything else off. */
  SUPPORT_MAIL_INTAKE_ENABLED?: string;
  /** Comma separated customer addresses to read; default contact@ and hello@opendrone.be. */
  SUPPORT_MAIL_ADDRESSES?: string;
  /** Google group addresses that relay customer mail (From the group, person in X-Original-Sender); none by default. */
  SUPPORT_MAIL_GROUPS?: string;
  /** Extra own domains, besides opendrone.be and incutec.eu. */
  SUPPORT_MAIL_OWN_DOMAINS?: string;
  /** Senders (address, @domain, domain) to take even when they look automated. */
  SUPPORT_MAIL_ALLOW?: string;
  /** Senders (address, @domain, domain) to always drop: suppliers, newsletters. */
  SUPPORT_MAIL_DENY?: string;
  /** How many days back each pass looks (1 to 14, default 2). */
  SUPPORT_MAIL_WINDOW_DAYS?: string;
};

export type MailMode = 'off' | 'dry' | 'on';

export function mailIntakeMode(env: MailEnv): MailMode {
  const v = env.SUPPORT_MAIL_INTAKE_ENABLED?.trim().toLowerCase();
  return v === '1' ? 'on' : v === 'dry' ? 'dry' : 'off';
}

/** The gate is open and Gmail credentials exist. */
export function mailIntakeReady(env: MailEnv): boolean {
  return mailIntakeMode(env) !== 'off' && gmailConfigured(env);
}

const DEFAULT_ADDRESSES = ['contact@opendrone.be', 'hello@opendrone.be'];

export function mailConfig(env: MailEnv): MailConfig {
  const addresses = listConfig(env.SUPPORT_MAIL_ADDRESSES);
  return {
    addresses: addresses.length ? addresses : DEFAULT_ADDRESSES,
    groups: listConfig(env.SUPPORT_MAIL_GROUPS),
    ownDomains: [...DEFAULT_OWN_DOMAINS, ...listConfig(env.SUPPORT_MAIL_OWN_DOMAINS)],
    allow: listConfig(env.SUPPORT_MAIL_ALLOW),
    deny: listConfig(env.SUPPORT_MAIL_DENY),
  };
}

function windowDays(env: MailEnv): number {
  const n = Number.parseInt(env.SUPPORT_MAIL_WINDOW_DAYS ?? '', 10);
  return Number.isFinite(n) ? Math.min(14, Math.max(1, n)) : 2;
}

/** The Gmail search: mail to the customer addresses, recent, not sent or drafted by us. */
export function gmailQuery(cfg: MailConfig, days: number): string {
  const to = cfg.addresses.flatMap((a) => [`to:${a}`, `deliveredto:${a}`]).join(' ');
  return `{${to}} newer_than:${days}d -in:sent -in:drafts`;
}

const DAY = 24 * 60 * 60 * 1000;
const MAX_FETCH = 40;
const MAX_LIST = 150;
const MAX_TICKETS = 5;
const MAX_REPLIES = 15;
const MAX_ATTEMPTS = 3;
const CLAIM_STALE_MS = 10 * 60 * 1000;
const SENDER_PER_DAY = 8;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------

type MailRow = {message_hash: string; gmail_id: string; gmail_thread_id: string; ref: string | null; outcome: string; reason: string | null; attempts: number; updated_at: number};

export function createMailStore(db: D1Database) {
  return {
    async byGmailId(gmailId: string): Promise<MailRow | null> {
      const own = await db.prepare('SELECT * FROM support_mail_messages WHERE gmail_id = ? LIMIT 1').bind(gmailId).first<MailRow>();
      if (own) return own;
      return db
        .prepare('SELECT m.* FROM support_mail_copies c JOIN support_mail_messages m ON m.message_hash = c.message_hash WHERE c.gmail_id = ?')
        .bind(gmailId)
        .first<MailRow>();
    },
    /** Remember another Gmail id of a message that is already decided. */
    async recordCopy(gmailId: string, hash: string, now: number): Promise<void> {
      await db.prepare('INSERT OR REPLACE INTO support_mail_copies (gmail_id, message_hash, updated_at) VALUES (?, ?, ?)').bind(gmailId, hash, now).run();
    },
    async byHash(hash: string): Promise<MailRow | null> {
      return db.prepare('SELECT * FROM support_mail_messages WHERE message_hash = ?').bind(hash).first<MailRow>();
    },
    /** First writer wins: true when this call took the message. */
    async claim(hash: string, m: Pick<MailMessage, 'id' | 'threadId' | 'receivedAt'>, now: number): Promise<boolean> {
      const r = await db
        .prepare(
          `INSERT OR IGNORE INTO support_mail_messages (message_hash, gmail_id, gmail_thread_id, outcome, attempts, received_at, updated_at)
           VALUES (?, ?, ?, 'claimed', 1, ?, ?)`,
        )
        .bind(hash, m.id, m.threadId, m.receivedAt || now, now)
        .run();
      return Number(r.meta?.changes ?? 0) > 0;
    },
    /** Take a 'retry' row, or a 'claimed' one whose worker died. */
    async reclaim(hash: string, now: number): Promise<boolean> {
      const r = await db
        .prepare(
          `UPDATE support_mail_messages SET outcome = 'claimed', attempts = attempts + 1, updated_at = ?
           WHERE message_hash = ? AND attempts < ? AND (outcome = 'retry' OR (outcome = 'claimed' AND updated_at < ?))`,
        )
        .bind(now, hash, MAX_ATTEMPTS, now - CLAIM_STALE_MS)
        .run();
      return Number(r.meta?.changes ?? 0) > 0;
    },
    async finish(hash: string, outcome: 'ticket' | 'reply' | 'ignored', now: number, extra: {ref?: string; reason?: string} = {}): Promise<void> {
      await db
        .prepare('UPDATE support_mail_messages SET outcome = ?, ref = ?, reason = ?, updated_at = ? WHERE message_hash = ?')
        .bind(outcome, extra.ref ?? null, extra.reason ?? null, now, hash)
        .run();
    },
    async fail(hash: string, now: number): Promise<void> {
      await db
        .prepare(`UPDATE support_mail_messages SET outcome = CASE WHEN attempts >= ? THEN 'failed' ELSE 'retry' END, updated_at = ? WHERE message_hash = ?`)
        .bind(MAX_ATTEMPTS, now, hash)
        .run();
    },
    /** Give a claim back unworked: the next pass takes it, without costing an attempt. */
    async release(hash: string, now: number): Promise<void> {
      await db
        .prepare(`UPDATE support_mail_messages SET outcome = 'retry', attempts = MAX(attempts - 1, 0), updated_at = ? WHERE message_hash = ?`)
        .bind(now, hash)
        .run();
    },
    async refForThread(threadId: string): Promise<string | null> {
      const row = await db
        .prepare('SELECT ref FROM support_mail_messages WHERE gmail_thread_id = ? AND ref IS NOT NULL ORDER BY received_at DESC LIMIT 1')
        .bind(threadId)
        .first<{ref: string}>();
      return row?.ref ?? null;
    },
    async prune(before: number): Promise<void> {
      await db.prepare('DELETE FROM support_mail_messages WHERE ref IS NULL AND updated_at < ?').bind(before).run();
      await db.prepare('DELETE FROM support_mail_copies WHERE updated_at < ?').bind(before).run();
    },
  };
}

export type MailStore = ReturnType<typeof createMailStore>;

// --------------------------------------------------------------------------
// The pass
// --------------------------------------------------------------------------

export type MailReport = {
  mode: MailMode;
  listed: number;
  fetched: number;
  tickets: string[];
  replies: string[];
  ignored: Record<string, number>;
  deferred: number;
  errors: number;
};

export type MailDeps = {
  deps: Deps;
  db: D1Database;
  /** Defaults to the Gmail API client built from deps.env. */
  gmail?: GmailClient;
};

const TRUNCATED = '\n[mail truncated]';
const WITHHELD = '(The text of this mail was withheld by the privacy filter. Open the original in the shared mailbox.)';

/** The ticket text of a new mail: subject line, the new text, a note about attachments. */
export function composeTicketText(subject: string, body: string, attachments: number): string {
  const parts = [subject ? `Subject: ${subject}` : '', body || '(no text)', attachments ? `(${attachments} attachment${attachments === 1 ? '' : 's'} in the mail, not imported)` : ''].filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > LIMITS.message ? `${text.slice(0, LIMITS.message - TRUNCATED.length)}${TRUNCATED}` : text;
}

function sourceNote(subject: string, attachments: number): string {
  const dropped = attachments ? `; ${attachments} attachment${attachments === 1 ? '' : 's'} not imported` : '';
  return [
    `*Source: mail. Subject: ${escapeDiscord(cleanText(subject).slice(0, 150)) || '(none)'}.`,
    `Quoted history and signature were removed${dropped}.`,
    'Reply here as for any ticket: the customer gets the usual "new reply" notice with the ticket link; nothing is mailed automatically.*',
  ].join(' ');
}

export async function runMailIntake(ctx: MailDeps): Promise<MailReport> {
  const {deps, db} = ctx;
  const env = deps.env as typeof deps.env & MailEnv;
  const mode = mailIntakeMode(env);
  const report: MailReport = {mode, listed: 0, fetched: 0, tickets: [], replies: [], ignored: {}, deferred: 0, errors: 0};
  if (mode === 'off' || !gmailConfigured(env)) return report;

  const now = (deps.now ?? Date.now)();
  const cfg = mailConfig(env);
  const gmail = ctx.gmail ?? createGmailClient(env, deps.fetcher ?? fetch, deps.now ?? Date.now);
  const store = createMailStore(db);
  const ignore = (reason: string) => {
    report.ignored[reason] = (report.ignored[reason] ?? 0) + 1;
  };

  const listed = await gmail.list(gmailQuery(cfg, windowDays(env)), MAX_LIST);
  report.listed = listed.length;

  // Skip what is already decided without fetching it. Oldest first, so a
  // backlog becomes tickets in the order it arrived.
  const todo: typeof listed = [];
  for (const item of listed) {
    const row = mode === 'on' ? await store.byGmailId(item.id) : null;
    if (row && row.outcome !== 'retry' && row.outcome !== 'claimed') continue;
    todo.push(item);
  }
  if (mode === 'on') todo.reverse();

  for (const item of todo.slice(0, MAX_FETCH)) {
    let m: MailMessage;
    try {
      m = await gmail.get(item.id);
    } catch (err) {
      report.errors++;
      console.warn('[support] mail fetch failed', err instanceof Error ? err.message : 'error');
      continue;
    }
    report.fetched++;
    const verdict = classify(m, cfg);

    if (mode === 'dry') {
      if (verdict.ok) report.tickets.push('(dry)');
      else ignore(verdict.reason);
      continue;
    }

    const messageId = headerOf(m, 'message-id');
    const hash = await sha256Hex(messageId || `gmail:${m.id}`);
    const existing = await store.byHash(hash);
    let retry = false;
    if (existing) {
      // Another Gmail copy of a message already handled, or a retry.
      if (!(await store.reclaim(hash, now))) {
        if (existing.gmail_id !== m.id) await store.recordCopy(m.id, hash, now);
        continue;
      }
      retry = true;
    } else if (!(await store.claim(hash, m, now))) {
      continue;
    }

    if (!verdict.ok) {
      await store.finish(hash, 'ignored', now, {reason: verdict.reason});
      ignore(verdict.reason);
      continue;
    }

    if (report.tickets.length >= MAX_TICKETS || report.replies.length >= MAX_REPLIES) {
      // Over this pass' budget: give the claim back, the next pass takes it.
      await store.release(hash, now);
      report.deferred++;
      continue;
    }

    try {
      // A leaky bucket per sender (8 mails a day), read before and charged
      // only after the mail became a ticket or reply.
      const senderKey = `mailsender:${await sha256Hex(verdict.sender.email)}`;
      if ((await deps.store.bucket(senderKey, 0, SENDER_PER_DAY / DAY, now)) >= SENDER_PER_DAY) {
        await store.finish(hash, 'ignored', now, {reason: 'sender_limit'});
        ignore('sender_limit');
        continue;
      }

      const subject = cleanSubject(headerOf(m, 'subject'));
      const body = bodyText(m);
      const outcome = await handleCustomerMail(ctx, store, {m, hash, subject, body, sender: verdict.sender, retry});
      if (outcome.kind === 'ignored') {
        await store.finish(hash, 'ignored', now, {reason: outcome.reason});
        ignore(outcome.reason);
        continue;
      }
      await deps.store.bucket(senderKey, 1, SENDER_PER_DAY / DAY, now);
      report[outcome.kind === 'ticket' ? 'tickets' : 'replies'].push(outcome.ref);
    } catch (err) {
      report.errors++;
      await store.fail(hash, now).catch(() => {});
      console.warn('[support] mail intake failed', err instanceof Error ? err.message : 'error');
    }
  }

  await store.prune(now - 30 * DAY).catch(() => {});
  return report;
}

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

async function handleCustomerMail(
  ctx: MailDeps,
  store: MailStore,
  mail: {m: MailMessage; hash: string; subject: string; body: string; sender: {email: string; name: string}; retry: boolean},
): Promise<{kind: 'ticket' | 'reply'; ref: string} | {kind: 'ignored'; reason: string}> {
  const {deps} = ctx;
  const {m, hash, subject, body, sender, retry} = mail;
  const now = (deps.now ?? Date.now)();

  // A follow-up: the reference in the subject, else the Gmail thread of an
  // earlier mail that became or joined a ticket. Only the ticket's own
  // sender continues it, and only while the team has not locked it.
  const ref = refInSubject(subject) ?? (await store.refForThread(m.threadId));
  const ticket = ref ? await deps.store.getTicket(ref) : null;
  if (ticket && ticket.email === sender.email && !ticket.locked) {
    const text = composeReplyText(body, m.attachmentCount);
    // A retry after a crash: the reply may already be in the ticket.
    if (retry) {
      const sent = scrubForDiscord(text).content;
      const already = (await deps.store.messages(ticket.ref)).some((x) => x.role === 'customer' && x.createdAt >= m.receivedAt && (x.body === sent || x.body === WITHHELD));
      if (already) {
        await store.finish(hash, 'reply', now, {ref: ticket.ref});
        return {kind: 'reply', ref: ticket.ref};
      }
    }
    let result = await addCustomerReply(deps, ticket, text);
    if (!result.ok && result.error === 'filtered') result = await addCustomerReply(deps, ticket, WITHHELD);
    if (result.ok) {
      await store.finish(hash, 'reply', now, {ref: ticket.ref});
      return {kind: 'reply', ref: ticket.ref};
    }
    // Only a lock falls through to a new ticket, so the customer is not
    // dropped. Any other refusal is recorded and counted.
    if (result.error !== 'locked') return {kind: 'ignored', reason: `reply_${result.error}`};
  }

  const text = composeTicketText(subject, body, m.attachmentCount);
  const scrubbed = scrubForDiscord(text);
  const message = scrubbed.blocked ? composeTicketText(subject, WITHHELD, m.attachmentCount) : scrubbed.content;
  // A retry after a crash: the ticket may exist already (created, not yet
  // recorded). Same sender, opened since the mail arrived, same first text.
  if (retry) {
    const orphan = (await deps.store.ticketsByEmail(sender.email, 5)).find(
      (t) => t.createdAt >= m.receivedAt && flat(message).startsWith(t.preview.replace(/…$/, '')),
    );
    if (orphan) {
      await store.finish(hash, 'ticket', now, {ref: orphan.ref});
      return {kind: 'ticket', ref: orphan.ref};
    }
  }
  const input: NewTicketInput = {
    topic: guessTopic(subject, body),
    name: displayName(sender),
    email: sender.email,
    // Shopify confirms it for this email or it is shown as unverified.
    orderNumber: orderNumberIn(subject, body),
    product: null,
    firmware: null,
    message,
  };
  const created = await createTicket(deps, input);
  await store.finish(hash, 'ticket', now, {ref: created.ref});
  try {
    await deps.discord.post(created.threadId, sourceNote(subject, m.attachmentCount));
  } catch {
    // The note is a convenience; the ticket stands without it.
  }
  return {kind: 'ticket', ref: created.ref};
}

function composeReplyText(body: string, attachments: number): string {
  const text = [body || '(no text)', attachments ? `(${attachments} attachment${attachments === 1 ? '' : 's'} in the mail, not imported)` : ''].filter(Boolean).join('\n\n');
  return text.length > LIMITS.message ? `${text.slice(0, LIMITS.message - TRUNCATED.length)}${TRUNCATED}` : text;
}
