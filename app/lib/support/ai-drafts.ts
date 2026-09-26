/**
 * ChatFPV ticket drafts: a suggested answer posted into the ticket's
 * Discord thread for the team, never straight to the customer.
 *
 *   new ticket or customer follow-up (topic product or other)
 *     -> older pending drafts of the ticket: superseded (outcome rejected)
 *     -> POST /v1/draft (scrubbed conversation, no name, email, phone,
 *        order data or attachments)
 *     -> one bot message in the thread, marked as an AI draft
 *   support-role approve reaction on that message (checked on every sync,
 *   whatever SUPPORT_MODERATION_MODE says: 'log' and 'off' never approve)
 *     -> the STORED body plus the AI suffix and source links, through
 *        scrubForPublic, relayed as an OpenDrone staff message
 *     -> outcome approved, decidedBy = the reactor
 *   a reply by a support-role holder relayed after the draft while it is
 *   pending
 *     -> outcome replaced, finalText = the delivered text with the
 *        customer's name, email and order references redacted (ChatFPV
 *        learns from it as a staff correction)
 *   a reply by anyone else relayed after the draft
 *     -> outcome rejected (never a correction)
 *   the ticket closes with a draft pending
 *     -> outcome rejected
 *
 * Every step runs behind `deps.chatfpv`, which server.ts wires only while
 * CHATFPV_DRAFTS_ENABLED is "1". Outcomes ChatFPV did not accept stay
 * `outcome_posted = 0` and are retried by the scheduled sync.
 */
import type {ChatFpvClient} from './chatfpv.ts';
import type {Citation, DraftOutcomeRequest, DraftRequest, DraftResponse} from './chatfpv-contract.ts';
import {compareSnowflakes, escapeDiscord, type DiscordMessage} from './discord.ts';
import {approveEmoji, isModerator} from './moderation.ts';
import {scrubForPublic} from './scrubber.ts';
import type {Ticket, TicketTopic} from './store.ts';
import type {Deps} from './tickets.ts';

export type DraftStatus = 'pending' | 'approved' | 'replaced' | 'rejected' | 'superseded';

export type StoredDraft = {
  draftId: string;
  ref: string;
  discordMessageId: string | null;
  body: string;
  citations: Citation[];
  status: DraftStatus;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  finalText: string | null;
  outcomePosted: boolean;
};

type DraftRow = {
  draft_id: string;
  ref: string;
  discord_message_id: string | null;
  body: string;
  citations: string;
  status: DraftStatus;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  final_text: string | null;
  outcome_posted: number;
};

function toDraft(r: DraftRow): StoredDraft {
  let citations: Citation[] = [];
  try {
    citations = JSON.parse(r.citations) as Citation[];
  } catch {
    citations = [];
  }
  return {
    draftId: r.draft_id,
    ref: r.ref,
    discordMessageId: r.discord_message_id,
    body: r.body,
    citations,
    status: r.status,
    createdAt: Number(r.created_at),
    decidedAt: r.decided_at === null ? null : Number(r.decided_at),
    decidedBy: r.decided_by,
    finalText: r.final_text,
    outcomePosted: Boolean(Number(r.outcome_posted)),
  };
}

export function createDraftStore(db: D1Database) {
  return {
    async insert(d: Pick<StoredDraft, 'draftId' | 'ref' | 'discordMessageId' | 'body' | 'citations' | 'createdAt'>): Promise<void> {
      await db
        .prepare(
          `INSERT OR IGNORE INTO support_ai_drafts (draft_id, ref, discord_message_id, body, citations, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        )
        .bind(d.draftId, d.ref, d.discordMessageId, d.body, JSON.stringify(d.citations), d.createdAt)
        .run();
    },

    async get(draftId: string): Promise<StoredDraft | null> {
      const row = await db.prepare('SELECT * FROM support_ai_drafts WHERE draft_id = ?').bind(draftId).first<DraftRow>();
      return row ? toDraft(row) : null;
    },

    async pending(ref: string): Promise<StoredDraft[]> {
      const {results} = await db
        .prepare(`SELECT * FROM support_ai_drafts WHERE ref = ? AND status = 'pending' ORDER BY created_at ASC`)
        .bind(ref)
        .all<DraftRow>();
      return results.map(toDraft);
    },

    /** Move a pending draft to its final status. False when it was no longer pending. */
    async decide(draftId: string, status: Exclude<DraftStatus, 'pending'>, at: number, by: string, finalText: string | null = null): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE support_ai_drafts SET status = ?, decided_at = ?, decided_by = ?, final_text = ?
           WHERE draft_id = ? AND status = 'pending'`,
        )
        .bind(status, at, by, finalText, draftId)
        .run();
      return Number(res.meta?.changes ?? 0) > 0;
    },

    async markPosted(draftId: string): Promise<void> {
      await db.prepare('UPDATE support_ai_drafts SET outcome_posted = 1 WHERE draft_id = ?').bind(draftId).run();
    },

    /** Decided drafts whose outcome ChatFPV has not accepted yet. */
    async unposted(limit: number): Promise<StoredDraft[]> {
      const {results} = await db
        .prepare(`SELECT * FROM support_ai_drafts WHERE outcome_posted = 0 AND status != 'pending' ORDER BY decided_at ASC LIMIT ?`)
        .bind(limit)
        .all<DraftRow>();
      return results.map(toDraft);
    },

    /** Pending drafts whose ticket is closed or gone. */
    async pendingOnClosed(limit: number): Promise<StoredDraft[]> {
      const {results} = await db
        .prepare(
          `SELECT d.* FROM support_ai_drafts d LEFT JOIN support_tickets t ON t.ref = d.ref
           WHERE d.status = 'pending' AND (t.ref IS NULL OR t.status = 'closed') LIMIT ?`,
        )
        .bind(limit)
        .all<DraftRow>();
      return results.map(toDraft);
    },

    /** Settled drafts of tickets the retention job deleted. */
    async pruneOrphans(): Promise<void> {
      await db
        .prepare(
          `DELETE FROM support_ai_drafts WHERE outcome_posted = 1 AND status != 'pending'
           AND ref NOT IN (SELECT ref FROM support_tickets)`,
        )
        .run();
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

/** What server.ts wires into Deps while CHATFPV_DRAFTS_ENABLED is "1". */
export type ChatFpvDeps = {client: ChatFpvClient; drafts: DraftStore};

// --------------------------------------------------------------------------
// Request
// --------------------------------------------------------------------------

export const DRAFT_TOPICS: ReadonlySet<TicketTopic> = new Set<TicketTopic>(['product', 'other']);
/** decidedBy for decisions no person made (superseded, closed, blocked). */
export const SYSTEM_DECIDER = 'system';
const MAX_POST = 1990;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Ticket text without the customer's identity: the order number and any
 * other "#1234" order reference, the email, and each part of the name.
 * The scrubber (chatfpv.ts) then removes emails, phones, IBANs and cards.
 */
export function redactTicketText(text: string, ticket: Pick<Ticket, 'name' | 'email' | 'orderNumber'>): string {
  let out = text;
  if (ticket.email) out = out.replace(new RegExp(escapeRe(ticket.email), 'gi'), '[email]');
  const digits = ticket.orderNumber?.replace(/\D/g, '');
  if (digits) out = out.replace(new RegExp(`(?<!\\d)(?:#\\s?)?${digits}(?!\\d)`, 'g'), '[order]');
  out = out.replace(/#\s?\d{3,}(?!\d)/g, '[order]');
  for (const part of ticket.name.split(/\s+/).filter((p) => p.length >= 2)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(part)}(?![\\p{L}\\p{N}])`, 'giu'), '[name]');
  }
  return out;
}

/** The DraftRequest for a ticket: topic and product from the ticket fields, the conversation redacted. */
export async function draftRequest(deps: Deps, ticket: Ticket, firmware?: string | null): Promise<DraftRequest> {
  const messages = await deps.store.messages(ticket.ref);
  const conversation = messages
    .filter((m) => (m.role === 'customer' || m.role === 'staff') && m.body.trim())
    .map((m) => ({role: m.role as 'customer' | 'staff', text: redactTicketText(m.body, ticket)}));
  return {
    ticketRef: ticket.ref,
    topic: ticket.topic,
    ...(ticket.product ? {product: redactTicketText(ticket.product, ticket)} : {}),
    ...(firmware ? {firmware: redactTicketText(firmware, ticket)} : {}),
    conversation,
  };
}

// --------------------------------------------------------------------------
// Posting
// --------------------------------------------------------------------------

/** Source lines for the citations the body does not already list (ChatFPV drafts carry their own "Sources:" block). */
function sourceLines(citations: Citation[], forDiscord: boolean, body = ''): string[] {
  return citations
    .filter((c) => !body.includes(c.url))
    .map((c) => (forDiscord ? `[${c.n}] ${escapeDiscord(c.title)} <${c.url}>` : `[${c.n}] ${c.title}: ${c.url}`));
}

/**
 * The thread message for a draft: the AI label, the body, the source links,
 * the note and the confidence, in one message under 1990 characters. Null
 * when the body alone does not fit (a draft is never shown cut short).
 */
export function draftPost(emoji: string, d: Pick<DraftResponse, 'draft' | 'citations' | 'note' | 'confidence'>): string | null {
  if (!d.draft) return null;
  const head = `**AI draft by ChatFPV, not sent to the customer.** React with ${emoji} to send it, or reply normally to send your own.`;
  const tail = `*${d.note ? `Note: ${escapeDiscord(d.note)} · ` : ''}confidence ${Math.round(d.confidence * 100)}%*`;
  const base = `${head}\n\n${d.draft}\n\n`;
  if (base.length + tail.length > MAX_POST) return null;
  const sources: string[] = [];
  for (const line of sourceLines(d.citations, true, d.draft)) {
    const block = ['Sources:', ...sources, line].join('\n');
    if (base.length + block.length + 2 + tail.length > MAX_POST) break;
    sources.push(line);
  }
  return `${base}${sources.length ? `${['Sources:', ...sources].join('\n')}\n` : ''}${tail}`;
}

/** The line posted when ChatFPV answered without a draft. */
export function noDraftLine(note: string): string | null {
  const n = note.trim();
  return n ? `*ChatFPV has no draft for this ticket: ${escapeDiscord(n).slice(0, 300)}*` : null;
}

export const APPROVED_SUFFIX = 'This reply was drafted with AI (ChatFPV) and checked by the OpenDrone team.';

/** The customer-facing text of an approved draft, before the scrubber. */
export function approvedText(d: Pick<StoredDraft, 'body' | 'citations'>): string {
  const sources = sourceLines(d.citations, false, d.body);
  return [d.body.trim(), APPROVED_SUFFIX, ...(sources.length ? [`Sources:\n${sources.join('\n')}`] : [])].join('\n\n');
}

const OUTCOME_OF: Record<Exclude<DraftStatus, 'pending'>, DraftOutcomeRequest['status']> = {
  approved: 'approved',
  replaced: 'replaced',
  rejected: 'rejected',
  superseded: 'rejected',
};

/** Tell ChatFPV; a failure leaves outcome_posted 0 for the scheduled retry. */
async function postOutcome(c: ChatFpvDeps, d: StoredDraft): Promise<void> {
  if (d.status === 'pending') return;
  // ChatFPV refuses a replaced outcome without text: report it as rejected.
  const replaced = d.status === 'replaced' && Boolean(d.finalText?.trim());
  const ok = await c.client.outcome({
    draftId: d.draftId,
    status: replaced ? 'replaced' : OUTCOME_OF[d.status === 'replaced' ? 'rejected' : d.status],
    ...(replaced ? {finalText: d.finalText!} : {}),
    decidedBy: d.decidedBy ?? SYSTEM_DECIDER,
  });
  if (ok) await c.drafts.markPosted(d.draftId);
}

/** Settle one pending draft and report it. False when another pass settled it first. */
export async function settleDraft(
  deps: Deps,
  d: StoredDraft,
  status: Exclude<DraftStatus, 'pending'>,
  by: string,
  finalText: string | null = null,
): Promise<boolean> {
  const c = deps.chatfpv;
  if (!c) return false;
  const at = (deps.now ?? Date.now)();
  if (!(await c.drafts.decide(d.draftId, status, at, by, finalText))) return false;
  // In the background when the request allows it: a slow ChatFPV never
  // holds a ticket page. A failure stays outcome_posted 0 for the retry.
  const report = postOutcome(c, {...d, status, decidedAt: at, decidedBy: by, finalText}).catch(() => {
    console.warn('[support] draft outcome not posted', d.draftId);
  });
  if (deps.defer) deps.defer(report);
  else await report;
  return true;
}

/**
 * The ticket hook (createTicket, addCustomerReply). Runs in the
 * background; the caller never waits on ChatFPV and never sees an error.
 */
export async function requestDraft(deps: Deps, ticket: Ticket, firmware?: string | null): Promise<void> {
  const c = deps.chatfpv;
  if (!c || !DRAFT_TOPICS.has(ticket.topic)) return;
  for (const old of await c.drafts.pending(ticket.ref)) await settleDraft(deps, old, 'superseded', SYSTEM_DECIDER);

  const res = await c.client.draft(await draftRequest(deps, ticket, firmware));
  if (!res) return;
  const post = draftPost(approveEmoji(deps.env), res);
  if (!post) {
    const line = noDraftLine(res.draft ? 'the draft is too long for one Discord message' : res.note);
    if (line) await deps.discord.post(ticket.threadId, line);
    if (res.draft) {
      const at = (deps.now ?? Date.now)();
      await c.drafts.insert({draftId: res.draftId, ref: ticket.ref, discordMessageId: null, body: res.draft, citations: res.citations, createdAt: at});
      const row = await c.drafts.get(res.draftId);
      if (row) await settleDraft(deps, row, 'rejected', SYSTEM_DECIDER);
    }
    return;
  }
  const messageId = await deps.discord.post(ticket.threadId, post);
  await c.drafts.insert({
    draftId: res.draftId,
    ref: ticket.ref,
    discordMessageId: messageId,
    body: res.draft!,
    citations: res.citations,
    createdAt: (deps.now ?? Date.now)(),
  });
}

// --------------------------------------------------------------------------
// Sync: approval, replacement, close
// --------------------------------------------------------------------------

/**
 * Reactor lookups that found no support-role holder, per message id and
 * reaction count, until the entry expires: a reaction removed and replaced
 * by a support-role holder's leaves the count unchanged.
 */
const NOT_APPROVED = new Map<string, number>();
const NOT_APPROVED_TTL_MS = 5 * 60 * 1000;
let lastSweep = 0;
const SWEEP_EVERY_MS = 60 * 1000;

export function _resetDraftCache(): void {
  NOT_APPROVED.clear();
  lastSweep = 0;
}

export type ApprovedDraft = {draft: StoredDraft; by: string; body: string};

/**
 * Drafts of this ticket approved since the last sync: a holder of
 * SUPPORT_MOD_ROLE_ID reacted with the approve emoji. The mode never
 * matters here. A draft whose message was deleted is rejected; a draft
 * the scrubber blocks is rejected with a note in the thread. Never throws.
 */
export async function reviewDrafts(
  deps: Deps,
  ticket: Ticket,
  recent: DiscordMessage[],
): Promise<{approved: ApprovedDraft[]; pending: StoredDraft[]}> {
  const c = deps.chatfpv;
  if (!c) return {approved: [], pending: []};
  let pending: StoredDraft[];
  try {
    pending = await c.drafts.pending(ticket.ref);
  } catch {
    return {approved: [], pending: []};
  }
  // A closed ticket sends nothing: its pending drafts are rejected by the caller.
  if (!pending.length || ticket.status === 'closed') return {approved: [], pending};
  const env = deps.env;
  const emoji = approveEmoji(env);
  const role = env.SUPPORT_MOD_ROLE_ID;
  const byId = new Map(recent.map((m) => [m.id, m]));
  const approved: ApprovedDraft[] = [];
  const still: StoredDraft[] = [];

  for (const d of pending) {
    try {
      if (!d.discordMessageId) {
        still.push(d);
        continue;
      }
      let live = byId.get(d.discordMessageId) ?? null;
      if (!live) live = await deps.discord.message(ticket.threadId, d.discordMessageId).catch(() => null);
      if (!live) {
        await settleDraft(deps, d, 'rejected', SYSTEM_DECIDER);
        continue;
      }
      const hint = live.reactions.find((r) => r.emoji === emoji);
      const others = hint ? hint.count - (hint.me ? 1 : 0) : 0;
      const key = `${d.discordMessageId}:${hint?.count ?? 0}`;
      if (!role || others <= 0 || (NOT_APPROVED.get(key) ?? 0) > Date.now()) {
        still.push(d);
        continue;
      }
      let by: string | null = null;
      for (const id of await deps.discord.reactors(ticket.threadId, d.discordMessageId, emoji)) {
        if (await deps.discord.hasRole(id, role)) {
          by = id;
          break;
        }
      }
      if (!by) {
        if (NOT_APPROVED.size >= 500) NOT_APPROVED.clear();
        NOT_APPROVED.set(key, Date.now() + NOT_APPROVED_TTL_MS);
        still.push(d);
        continue;
      }
      const scrubbed = scrubForPublic(approvedText(d), {keepPhones: env.PUBLIC_COMPANY_TEL ? [env.PUBLIC_COMPANY_TEL] : []});
      if (scrubbed.blocked || !scrubbed.content) {
        console.warn('[support] approved draft blocked by scrubber', ticket.ref, d.draftId, scrubbed.reasons.join(','));
        await settleDraft(deps, d, 'rejected', by);
        deps.discord.post(ticket.threadId, `*${ticket.ref}: the approved AI draft was blocked by the scrubber and not sent. Reply normally instead.*`).catch(() => {});
        continue;
      }
      approved.push({draft: d, by, body: scrubbed.content});
    } catch (err) {
      console.warn('[support] draft review failed', ticket.ref, d.draftId, err instanceof Error ? err.message : 'error');
      still.push(d);
    }
  }
  return {approved, pending: still};
}

/** After an approved draft reached the customer: settle it and mark it in the thread. */
export async function draftDelivered(deps: Deps, ticket: Ticket, a: ApprovedDraft): Promise<void> {
  try {
    if (await settleDraft(deps, a.draft, 'approved', a.by)) {
      deps.discord.react(ticket.threadId, a.draft.discordMessageId!, '📨').catch(() => {});
    }
  } catch (err) {
    console.warn('[support] draft settle failed', ticket.ref, a.draft.draftId, err instanceof Error ? err.message : 'error');
  }
}

/**
 * A staff reply was relayed: every draft posted before it and still
 * pending is settled by it. Only a support-role holder's reply is a
 * correction ('replaced', its text redacted like a draft request); anyone
 * else's rejects the draft, whatever the moderation mode relayed.
 * Returns the drafts that stay pending.
 */
export async function draftsReplaced(
  deps: Deps,
  ticket: Pick<Ticket, 'name' | 'email' | 'orderNumber'>,
  pending: StoredDraft[],
  reply: DiscordMessage,
  delivered: string,
): Promise<StoredDraft[]> {
  const still: StoredDraft[] = [];
  const before = pending.filter((d) => d.discordMessageId && compareSnowflakes(d.discordMessageId, reply.id) < 0);
  if (!before.length) return pending;
  let staff = false;
  try {
    staff = Boolean(deps.env.SUPPORT_MOD_ROLE_ID) && (await isModerator(deps.env, deps.discord, reply.author.id));
  } catch {
    staff = false;
  }
  const finalText = staff ? redactTicketText(delivered, ticket).trim() : '';
  for (const d of pending) {
    if (before.includes(d)) {
      try {
        if (finalText) await settleDraft(deps, d, 'replaced', reply.author.id, finalText);
        else await settleDraft(deps, d, 'rejected', reply.author.id);
      } catch (err) {
        console.warn('[support] draft replace failed', d.ref, d.draftId, err instanceof Error ? err.message : 'error');
      }
    } else {
      still.push(d);
    }
  }
  return still;
}

/** The ticket closed: every pending draft is rejected. */
export async function draftsRejected(deps: Deps, pending: StoredDraft[], by: string): Promise<void> {
  for (const d of pending) {
    try {
      await settleDraft(deps, d, 'rejected', by);
    } catch (err) {
      console.warn('[support] draft reject failed', d.ref, d.draftId, err instanceof Error ? err.message : 'error');
    }
  }
}

/**
 * The scheduled part (a forced sync, which only the cron runs; at most once
 * a minute per isolate): outcomes ChatFPV did not accept are posted again,
 * pending drafts of closed or deleted tickets are rejected, settled drafts
 * of deleted tickets go.
 */

export async function sweepDrafts(deps: Deps, opts: {force?: boolean} = {}): Promise<void> {
  const c = deps.chatfpv;
  if (!c) return;
  const now = (deps.now ?? Date.now)();
  if (!opts.force && now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  try {
    for (const d of await c.drafts.pendingOnClosed(20)) await settleDraft(deps, d, 'rejected', SYSTEM_DECIDER);
    for (const d of await c.drafts.unposted(20)) await postOutcome(c, d);
    await c.drafts.pruneOrphans();
  } catch (err) {
    console.warn('[support] draft sweep failed', err instanceof Error ? err.message : 'error');
  }
}
