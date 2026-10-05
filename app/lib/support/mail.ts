/**
 * Customer mail answered by email (README "Mail").
 *
 * Every cron pass (server.ts `scheduled`, behind SUPPORT_MAIL_INTAKE_ENABLED)
 * asks Gmail for the last few days of mail sent to the customer addresses,
 * drops everything that is not a customer (mail-parse.ts `classify`), and for
 * each remaining mail asks ChatFPV for a reply draft (public audience only,
 * no order data, Shopify is never called) and saves it as a Gmail DRAFT reply
 * in the same Gmail thread of SUPPORT_MAIL_MAILBOX. A person opens Gmail,
 * edits and sends. This module never sends mail: the Gmail client has no
 * send function. A sender the mail system did not authenticate still gets a
 * draft, whose first line asks the person to check before sending.
 * One message in the staff Discord channel counts what the pass left in Gmail.
 *
 * Modes (SUPPORT_MAIL_INTAKE_ENABLED): anything but "1" or "dry" is off;
 * "dry" fetches and classifies and only reports counts, writing nothing and
 * asking Gmail for the read-only scope.
 *
 * Idempotency: a row per message in support_mail_messages, keyed by the
 * SHA-256 of the Message-ID header, claimed before the work starts. A
 * failure marks the row "retry" (3 attempts). The one remaining window is a
 * Worker killed between creating a draft and recording it, which would leave
 * two drafts of that mail after the retry.
 */
import {redactTicketText} from './ai-drafts.ts';
import {createGmailClient, gmailConfigured, type GmailClient, type GmailEnv} from './mail-gmail.ts';
import {draftRaw} from './mail-draft.ts';
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
  type MailConfig,
  type MailMessage,
} from './mail-parse.ts';
import type {Deps} from './tickets.ts';

export type MailEnv = GmailEnv & {
  /** "1" on, "dry" report only, anything else off. */
  SUPPORT_MAIL_INTAKE_ENABLED?: string;
  /** Comma separated customer addresses to read; default contact@ and hello@opendrone.be. */
  SUPPORT_MAIL_ADDRESSES?: string;
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
const MAX_DRAFTS = 5;
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

type MailRow = {message_hash: string; gmail_id: string; gmail_thread_id: string; gmail_draft_id: string | null; outcome: string; reason: string | null; attempts: number; updated_at: number};

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
    async finish(hash: string, outcome: 'drafted' | 'ignored', now: number, extra: {draftId?: string; reason?: string} = {}): Promise<void> {
      await db
        .prepare('UPDATE support_mail_messages SET outcome = ?, gmail_draft_id = ?, reason = ?, updated_at = ? WHERE message_hash = ?')
        .bind(outcome, extra.draftId ?? null, extra.reason ?? null, now, hash)
        .run();
    },
    /** Count a failed attempt; the new outcome, 'retry' or (after the last attempt) 'failed'. */
    async fail(hash: string, now: number): Promise<'retry' | 'failed'> {
      await db
        .prepare(`UPDATE support_mail_messages SET outcome = CASE WHEN attempts >= ? THEN 'failed' ELSE 'retry' END, updated_at = ? WHERE message_hash = ?`)
        .bind(MAX_ATTEMPTS, now, hash)
        .run();
      const row = await db.prepare('SELECT outcome FROM support_mail_messages WHERE message_hash = ?').bind(hash).first<{outcome: string}>();
      return row?.outcome === 'failed' ? 'failed' : 'retry';
    },
    /** Give a claim back unworked: the next pass takes it, without costing an attempt. */
    async release(hash: string, now: number): Promise<void> {
      await db
        .prepare(`UPDATE support_mail_messages SET outcome = 'retry', attempts = MAX(attempts - 1, 0), updated_at = ? WHERE message_hash = ?`)
        .bind(now, hash)
        .run();
    },
    async prune(before: number): Promise<void> {
      await db.prepare('DELETE FROM support_mail_messages WHERE updated_at < ?').bind(before).run();
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
  /** Mails that passed every filter (dry mode: the mails it would have drafted). */
  eligible: number;
  /** Gmail drafts created in this pass, and how many of them are for a sender the mail system did not authenticate. */
  drafted: number;
  unverified: number;
  /** Mails whose attempt this pass produced no draft (ChatFPV gave none, or Gmail refused); they retry. */
  noDraft: number;
  /** Mails that used their last attempt this pass: no draft, no more retries. */
  gaveUp: number;
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

/** The text ChatFPV sees: subject and new text without the sender's name, address or any order reference. */
function draftQuestion(subject: string, body: string, sender: {email: string; name: string}): string {
  const text = [subject ? `Subject: ${subject}` : '', body || '(no text)'].filter(Boolean).join('\n\n');
  return redactTicketText(text, {name: displayName(sender), email: sender.email, orderNumber: orderNumberIn(subject, body)});
}

/** The reply draft text: the ChatFPV draft and any source it did not already list. */
function replyText(res: {draft: string | null; citations: Array<{n: number; title: string; url: string}>}): string | null {
  const body = res.draft?.trim();
  if (!body) return null;
  const extra = res.citations.filter((c) => !body.includes(c.url)).map((c) => `[${c.n}] ${c.title}: ${c.url}`);
  return extra.length ? `${body}\n\nSources:\n${extra.join('\n')}` : body;
}

/** The staff channel line after a pass: counts only, no customer names, addresses, subjects or text. */
export function headsUp(r: Pick<MailReport, 'drafted' | 'unverified' | 'gaveUp'>): string | null {
  if (!r.drafted && !r.gaveUp) return null;
  const parts: string[] = [];
  if (r.drafted) {
    const n = `${r.drafted} draft ${r.drafted === 1 ? 'reply' : 'replies'}`;
    parts.push(`${n} waiting in Gmail${r.unverified ? ` (${r.unverified} sender not authenticated)` : ''}`);
  }
  if (r.gaveUp) parts.push(`${r.gaveUp} ${r.gaveUp === 1 ? 'mail' : 'mails'} without a draft`);
  return `Mail: ${parts.join(', ')}.`;
}

export async function runMailIntake(ctx: MailDeps): Promise<MailReport> {
  const {deps, db} = ctx;
  const env = deps.env as typeof deps.env & MailEnv;
  const mode = mailIntakeMode(env);
  const report: MailReport = {mode, listed: 0, fetched: 0, eligible: 0, drafted: 0, unverified: 0, noDraft: 0, gaveUp: 0, ignored: {}, deferred: 0, errors: 0};
  if (mode === 'off' || !gmailConfigured(env)) return report;
  const chatfpv = deps.chatfpv?.client;
  if (mode === 'on' && !chatfpv) {
    // Without ChatFPV there is nothing to draft: leave the mail alone (no claim, no attempt used).
    console.warn('[support] mail drafts need CHATFPV_DRAFTS_ENABLED "1" with CHATFPV_URL and CHATFPV_KEY; nothing was read');
    return report;
  }

  const now = (deps.now ?? Date.now)();
  const cfg = mailConfig(env);
  const gmail = ctx.gmail ?? createGmailClient(env, deps.fetcher ?? fetch, deps.now ?? Date.now, {compose: mode === 'on'});
  const store = createMailStore(db);
  const ignore = (reason: string) => {
    report.ignored[reason] = (report.ignored[reason] ?? 0) + 1;
  };

  const listed = await gmail.list(gmailQuery(cfg, windowDays(env)), MAX_LIST);
  report.listed = listed.length;

  // Skip what is already decided without fetching it. Oldest first, so a
  // backlog is drafted in the order it arrived.
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
      if (verdict.ok) report.eligible++;
      else ignore(verdict.reason);
      continue;
    }

    const messageId = headerOf(m, 'message-id');
    const hash = await sha256Hex(messageId || `gmail:${m.id}`);
    const existing = await store.byHash(hash);
    if (existing) {
      // Another Gmail copy of a message already handled, or a retry.
      if (!(await store.reclaim(hash, now))) {
        if (existing.gmail_id !== m.id) await store.recordCopy(m.id, hash, now);
        continue;
      }
    } else if (!(await store.claim(hash, m, now))) {
      continue;
    }

    if (!verdict.ok) {
      await store.finish(hash, 'ignored', now, {reason: verdict.reason});
      ignore(verdict.reason);
      continue;
    }
    report.eligible++;

    if (report.drafted >= MAX_DRAFTS) {
      // Over this pass' budget: give the claim back, the next pass takes it.
      await store.release(hash, now);
      report.deferred++;
      continue;
    }

    const failed = async () => {
      const outcome = await store.fail(hash, now).catch(() => 'retry' as const);
      if (outcome === 'failed') report.gaveUp++;
      else report.noDraft++;
    };

    try {
      // A leaky bucket per sender (8 mails a day), read before and charged
      // only after the mail got its draft.
      const senderKey = `mailsender:${await sha256Hex(verdict.sender.email)}`;
      if ((await deps.store.bucket(senderKey, 0, SENDER_PER_DAY / DAY, now)) >= SENDER_PER_DAY) {
        await store.finish(hash, 'ignored', now, {reason: 'sender_limit'});
        ignore('sender_limit');
        continue;
      }

      const subject = cleanSubject(headerOf(m, 'subject'));
      const body = bodyText(m);
      // No order data goes to ChatFPV and Shopify is not called on this path.
      const res = await chatfpv!.draft({
        ticketRef: `mail-${hash.slice(0, 16)}`,
        topic: guessTopic(subject, body),
        conversation: [{role: 'customer', text: draftQuestion(subject, body, verdict.sender)}],
      });
      const reply = res ? replyText(res) : null;
      if (!reply) {
        // ChatFPV unavailable or no draft: nothing is created in Gmail.
        await failed();
        continue;
      }
      const raw = draftRaw({mail: m, reply, original: body, verified: verdict.verified});
      if (!raw) {
        await store.finish(hash, 'ignored', now, {reason: 'no_reply_address'});
        ignore('no_reply_address');
        continue;
      }
      const draftId = await gmail.createDraft(m.threadId, raw);
      await store.finish(hash, 'drafted', now, {draftId});
      await deps.store.bucket(senderKey, 1, SENDER_PER_DAY / DAY, now);
      report.drafted++;
      if (!verdict.verified) report.unverified++;
    } catch (err) {
      report.errors++;
      await failed();
      console.warn('[support] mail draft failed', err instanceof Error ? err.message : 'error');
    }
  }

  if (mode === 'on') {
    // Dry mode writes nothing, not even the prune.
    await store.prune(now - 30 * DAY).catch(() => {});
    await announce(deps, report);
  }
  return report;
}

/** One staff channel message when the pass left drafts or gave up on a mail. Never throws. */
async function announce(deps: Deps, report: MailReport): Promise<void> {
  const line = headsUp(report);
  const channel = deps.env.DISCORD_STAFF_METADATA_CHANNEL_ID;
  if (!line) return;
  if (!channel) {
    console.warn('[support] mail heads-up not posted: DISCORD_STAFF_METADATA_CHANNEL_ID is not set');
    return;
  }
  try {
    // postToChannel sends allowed_mentions {parse: []}.
    await deps.discord.postToChannel(channel, line);
  } catch (err) {
    console.warn('[support] mail heads-up failed', err instanceof Error ? err.message : 'error');
  }
}
