/**
 * Staff actions of the CRM (README "Support tickets"). The staff API
 * (staff-api.ts) calls these; each is a rule on its own, tested without HTTP.
 * Staff replies are written to the customer-visible conversation; the ticket
 * page shows them at once and the cron's reply notice mails the customer, the
 * same path as a reply written in Discord. A person always clicks Send: AI
 * output is only ever a draft that `draftId` names.
 */
import {chunkMessage, cleanText, escapeDiscord, type OutboundFile} from './discord.ts';
import {approvedText, settleDraft} from './ai-drafts.ts';
import {fileLine, storeFiles} from './files.ts';
import {hasThread} from './flags.ts';
import {customerAdminUrl, lookupCustomer, type OrderSummary} from './shopify.ts';
import {scrubForPublic} from './scrubber.ts';
import {PRIORITIES, type Priority, type StoredAttachment, type Ticket, type TicketMessage, type TicketStatus} from './store.ts';
import {validLogin} from './staff-auth.ts';
import {closeTicket, humanTag, normalizeText, type Deps} from './tickets.ts';

export const MAX_STAFF_REPLY = 8000;
export const MAX_NOTE = 4000;

export type ReplyOk = {ok: true; ticket: Ticket; message: TicketMessage | null};
export type ReplyFail = {ok: false; error: 'locked' | 'empty' | 'too_long' | 'filtered' | 'files_unavailable'};

export async function sendStaffReply(
  deps: Deps,
  ticket: Ticket,
  opts: {login: string; author?: string; body: string; draftId?: string; status?: 'answered' | 'waiting'; files?: OutboundFile[]},
): Promise<ReplyOk | ReplyFail> {
  if (ticket.locked) return {ok: false, error: 'locked'};
  const files = opts.files ?? [];
  const text = normalizeText(opts.body);
  if (!text && !files.length) return {ok: false, error: 'empty'};
  if (text.length > MAX_STAFF_REPLY) return {ok: false, error: 'too_long'};
  if (files.length && !deps.files) return {ok: false, error: 'files_unavailable'};
  const scrubbed = scrubForPublic(text, {keepPhones: deps.env.PUBLIC_COMPANY_TEL ? [deps.env.PUBLIC_COMPANY_TEL] : []});
  if (scrubbed.blocked) return {ok: false, error: 'filtered'};

  const now = (deps.now ?? Date.now)();
  const author = cleanText(opts.author ?? '').slice(0, 40) || 'OpenDrone';
  const attachments: StoredAttachment[] = files.length ? await storeFiles(deps.files!, ticket.ref, files) : [];
  await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'staff', author, body: scrubbed.content, attachments, createdAt: now});
  const message = await deps.store.lastMessage(ticket.ref);

  if (ticket.status === 'closed') {
    await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: 'reopened_by_team', attachments: [], createdAt: now});
  }
  const status: TicketStatus = opts.status ?? 'answered';
  const patch = {status, closedAt: null, updatedAt: now, lastStaffAt: now, ...(ticket.assignee ? {} : {assignee: opts.login})};
  await deps.store.updateTicket(ticket.ref, patch);
  const next = {...ticket, ...patch};

  // Settle the AI drafts this reply answers: the unmodified draft is approved, anything else replaces it.
  if (deps.chatfpv) {
    for (const d of await deps.chatfpv.drafts.pending(ticket.ref)) {
      const sent = d.draftId === opts.draftId && normalizeText(approvedText(d)) === text;
      await settleDraft(deps, d, sent ? 'approved' : 'replaced', opts.login, sent ? null : scrubbed.content).catch(() => {});
    }
  }
  await deps.store.audit(opts.login, 'reply', ticket.ref, `seq=${message?.seq ?? 0} files=${attachments.length}${opts.draftId ? ` draft=${opts.draftId}` : ''} status=${status}`, now);

  // A thread from before the CRM still shows the conversation: text and a file line only.
  if (hasThread(ticket)) {
    const body = [escapeDiscord(scrubbed.content), escapeDiscord(fileLine(attachments))].filter(Boolean).join('\n');
    const chunks = chunkMessage(body || '(attachment)', 1800).map((c, i) => `${i === 0 ? `**${escapeDiscord(author)} · staff (CRM)**\n` : ''}${c}`);
    const mirror = (async () => {
      for (const c of chunks) await deps.discord.post(ticket.threadId, c);
    })().catch((err) => console.warn('[support] reply not mirrored to the thread', ticket.ref, err instanceof Error ? err.message : 'error'));
    if (deps.defer) deps.defer(mirror);
    else await mirror;
  }
  return {ok: true, ticket: next, message};
}

export type TicketChanges = {status?: TicketStatus; assignee?: string | null; priority?: Priority; tags?: string[]};

const TAG_RE = /^[a-z0-9][a-z0-9 ._:-]{0,29}$/;

/** Validated changes, or the name of the first bad field. */
export function parseChanges(raw: unknown): {ok: true; changes: TicketChanges} | {ok: false; field: string} {
  if (!raw || typeof raw !== 'object') return {ok: false, field: 'body'};
  const r = raw as Record<string, unknown>;
  const changes: TicketChanges = {};
  if ('status' in r) {
    if (!['open', 'waiting', 'answered', 'closed'].includes(String(r.status))) return {ok: false, field: 'status'};
    changes.status = r.status as TicketStatus;
  }
  if ('assignee' in r) {
    if (r.assignee !== null && !validLogin(r.assignee as string)) return {ok: false, field: 'assignee'};
    changes.assignee = r.assignee as string | null;
  }
  if ('priority' in r) {
    if (!PRIORITIES.includes(r.priority as Priority)) return {ok: false, field: 'priority'};
    changes.priority = r.priority as Priority;
  }
  if ('tags' in r) {
    if (!Array.isArray(r.tags) || r.tags.length > 10) return {ok: false, field: 'tags'};
    const tags = [...new Set(r.tags.map((t) => String(t).trim().toLowerCase()))];
    if (tags.some((t) => !TAG_RE.test(t))) return {ok: false, field: 'tags'};
    changes.tags = tags;
  }
  return Object.keys(changes).length ? {ok: true, changes} : {ok: false, field: 'body'};
}

export async function applyChanges(deps: Deps, ticket: Ticket, changes: TicketChanges, login: string): Promise<Ticket> {
  const now = (deps.now ?? Date.now)();
  let next = ticket;
  if (changes.status && changes.status !== ticket.status) {
    if (changes.status === 'closed') next = await closeTicket(deps, next, 'team');
    else {
      if (ticket.status === 'closed') {
        await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: 'reopened_by_team', attachments: [], createdAt: now});
      }
      const patch = {status: changes.status, closedAt: null, updatedAt: now};
      await deps.store.updateTicket(ticket.ref, patch);
      next = {...next, ...patch};
    }
  }
  const rest: Partial<Pick<Ticket, 'assignee' | 'priority' | 'tags'>> = {};
  if (changes.assignee !== undefined) rest.assignee = changes.assignee;
  if (changes.priority) rest.priority = changes.priority;
  if (changes.tags) rest.tags = changes.tags;
  if (Object.keys(rest).length) {
    await deps.store.updateTicket(ticket.ref, rest);
    next = {...next, ...rest};
  }
  const detail = Object.entries(changes).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v ?? 'none'}`).join(' ');
  await deps.store.audit(login, 'update', ticket.ref, detail, now);
  return next;
}

export async function addInternalNote(deps: Deps, ticket: Ticket, login: string, body: string) {
  const text = normalizeText(body);
  if (!text) return null;
  const now = (deps.now ?? Date.now)();
  const note = await deps.store.addNote(ticket.ref, login, text.slice(0, MAX_NOTE), now);
  await deps.store.audit(login, 'note', ticket.ref, `id=${note.id}`, now);
  return note;
}

export type CustomerCard = {
  match: Ticket['customerMatch'];
  /** An order of this email matched the order number given on the ticket (not proof of identity). */
  orderMatched: boolean;
  shopifyUrl: string | null;
  orders: Array<{name: string; createdAt: string; financial: string | null; fulfillment: string | null; preorderBatches: string[]; items: Array<{sku: string | null; title: string; quantity: number}>}>;
  earlierTickets: Array<{ref: string; status: TicketStatus; subject: string; createdAt: number; orderVerified: boolean}>;
};

const cardOrder = (o: OrderSummary) => ({
  name: o.name,
  createdAt: o.createdAt,
  financial: o.financial,
  fulfillment: o.fulfillment,
  preorderBatches: o.batchTags.filter((t) => /^batch:/i.test(t)).map(humanTag),
  items: o.items,
});

/**
 * Orders and preorder batch only for a ticket whose order number Shopify
 * confirmed for the ticket's email, like the Discord staff card. No address,
 * phone or payment detail is read or returned.
 */
export async function customerCard(deps: Deps, ticket: Ticket): Promise<CustomerCard> {
  const earlier = (await deps.store.ticketsByEmail(ticket.email, 10)).filter((t) => t.ref !== ticket.ref);
  let orders: CustomerCard['orders'] = [];
  let shopifyUrl: string | null = null;
  if (ticket.orderVerified && ticket.customerMatch === 'matched') {
    try {
      const ctx = await lookupCustomer(deps.env, ticket.email, deps.fetcher ?? fetch);
      if (ctx.match === 'matched') {
        orders = ctx.orders.slice(0, 8).map(cardOrder);
        shopifyUrl = customerAdminUrl(deps.env, ctx.customerId);
      }
    } catch (err) {
      console.warn('[support] customer card lookup failed', ticket.ref, err instanceof Error ? err.message : 'error');
    }
  }
  return {
    match: ticket.customerMatch,
    orderMatched: ticket.orderVerified,
    shopifyUrl,
    orders,
    earlierTickets: earlier.map((t) => ({ref: t.ref, status: t.status, subject: t.subject, createdAt: t.createdAt, orderVerified: t.orderVerified})),
  };
}
