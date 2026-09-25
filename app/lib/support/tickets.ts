/**
 * Support tickets: the rules in one place. Routes parse requests and render;
 * this module creates tickets, relays both ways between the site and the
 * ticket's Discord thread, moves status, finds tickets, and runs the
 * scheduled sync, notification, auto-close and retention jobs.
 *
 * Status:
 *   open      waiting on the team (new ticket, or the customer wrote last)
 *   answered  the team replied
 *   waiting   the team needs something from the customer (`!waiting`)
 *   closed    solved: by the customer, by `!close`, by locking the thread
 *             (locked: no more replies), after 30 days without an answer to
 *             a reply, or after 90 days without any activity
 *
 * Staff work in the thread: every message is relayed to the customer after
 * the scrubber (and the moderation gate when enabled), except messages that
 * start with `//` (internal notes) and the commands `!waiting`, `!answered`,
 * `!close` and `!open`. Messages are processed in thread order, once: a
 * reply held by the moderation gate holds everything after it too.
 *
 * Identity: the email on a ticket is unverified. Only an order number that
 * Shopify confirms for that email links the ticket to the Shopify customer,
 * shows staff the order history and writes to Shopify, and only such an
 * order number (or the ticket's own reference) finds tickets again.
 */
import {
  DiscordError,
  chunkMessage,
  cleanText,
  compareSnowflakes,
  escapeDiscord,
  neutralizeLinks,
  threadName,
  threadUrl,
  type DiscordClient,
  type DiscordEnv,
  type DiscordMessage,
  type OutboundFile,
} from './discord.ts';
import {approveEmoji, decide, resolveMode, type ModerationEnv} from './moderation.ts';
import {sendReplyNotice} from './notify.ts';
import {extractFirstName, scrubForDiscord, scrubForPublic} from './scrubber.ts';
import {
  customerAdminUrl,
  isEmail,
  lookupCustomer,
  normalizeOrderNumber,
  ownedOrder,
  recordOnCustomer,
  shopifyWritesEnabled,
  type CustomerContext,
  type OrderSummary,
  type ShopifyEnv,
} from './shopify.ts';
import type {SupportStore, Ticket, TicketMessage, TicketStatus, TicketTopic} from './store.ts';
import {newTicketRef, parseTicketRef, resumeUrl, signResumeToken} from './tokens.ts';
import {LIMITS, TOPIC_FIELDS, TOPICS, normalizeText} from './form.ts';

export {LIMITS, TOPIC_FIELDS, TOPICS, normalizeText};

export type SupportEnv = DiscordEnv &
  ModerationEnv &
  ShopifyEnv & {
    SUPPORT_SESSION_SECRET?: string;
    SESSION_SECRET?: string;
    SUPPORT_EMAIL_NOTIFY_ENABLED?: string;
    RESEND_API_KEY?: string;
    SUPPORT_FROM_EMAIL?: string;
    PUBLIC_COMPANY_TEL?: string;
  };

export type Deps = {
  env: SupportEnv;
  store: SupportStore;
  discord: DiscordClient;
  /** Shopify and Resend calls; Discord has its own client. */
  fetcher?: typeof fetch;
  now?: () => number;
  /** Public origin, for links written to Discord, Shopify and email. */
  origin: string;
  /** Background work (waitUntil); awaited inline when absent. */
  defer?: (p: Promise<unknown>) => void;
};

const TOPIC_LABEL: Record<TicketTopic, string> = {
  order: 'Order or preorder',
  product: 'Product or technical',
  warranty: 'Warranty or return',
  other: 'Other',
};

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 730 * DAY;
export const AUTO_CLOSE_MS = 30 * DAY;
export const IDLE_CLOSE_MS = 90 * DAY;
const NOTIFY_DELAY_MS = 10 * 60 * 1000;
const SYNC_THROTTLE_MS = 4000;

// --------------------------------------------------------------------------
// Input
// --------------------------------------------------------------------------

export type NewTicketInput = {
  topic: TicketTopic;
  name: string;
  email: string;
  orderNumber: string | null;
  product: string | null;
  firmware: string | null;
  message: string;
};

export type FieldError = 'required' | 'invalid' | 'too_short' | 'too_long' | 'filtered';

const str = (form: FormData, key: string, max: number) => String(form.get(key) ?? '').trim().slice(0, max);

export function parseNewTicket(
  form: FormData,
): {ok: true; input: NewTicketInput} | {ok: false; errors: Partial<Record<keyof NewTicketInput, FieldError>>} {
  const errors: Partial<Record<keyof NewTicketInput, FieldError>> = {};
  const topic = String(form.get('topic') ?? '') as TicketTopic;
  if (!TOPICS.includes(topic)) errors.topic = 'required';
  const fields = TOPIC_FIELDS[topic] ?? TOPIC_FIELDS.other;

  const name = cleanText(str(form, 'name', LIMITS.name));
  if (name.length < 1) errors.name = 'required';
  const email = str(form, 'email', 254).toLowerCase();
  if (!email) errors.email = 'required';
  else if (!isEmail(email)) errors.email = 'invalid';

  const rawOrder = str(form, 'order', 20);
  let orderNumber: string | null = null;
  if (fields.order) {
    orderNumber = normalizeOrderNumber(rawOrder);
    if (!rawOrder && fields.order === 'required') errors.orderNumber = 'required';
    else if (rawOrder && !orderNumber) errors.orderNumber = 'invalid';
  }
  let product: string | null = null;
  if (fields.product) {
    product = cleanText(str(form, 'product', LIMITS.product)) || null;
    if (!product && fields.product === 'required') errors.product = 'required';
  }
  const firmware = fields.firmware ? cleanText(str(form, 'firmware', LIMITS.firmware)) || null : null;

  const rawMessage = normalizeText(String(form.get('message') ?? ''));
  let message = '';
  if (rawMessage.length < LIMITS.minMessage) errors.message = rawMessage ? 'too_short' : 'required';
  else if (rawMessage.length > LIMITS.message) errors.message = 'too_long';
  else {
    const scrubbed = scrubForDiscord(rawMessage);
    if (scrubbed.blocked) errors.message = 'filtered';
    else message = scrubbed.content;
  }
  if (Object.keys(errors).length) return {ok: false, errors};
  return {ok: true, input: {topic, name, email, orderNumber, product, firmware, message}};
}

/** A short subject from the form, for lists and the page title. */
export function subjectFor(input: Pick<NewTicketInput, 'topic' | 'orderNumber' | 'product'>): string {
  const order = input.orderNumber ? `order ${input.orderNumber}` : null;
  const subject =
    input.topic === 'order'
      ? `Order ${input.orderNumber ?? ''}`.trim()
      : input.topic === 'warranty'
        ? `Warranty: ${[input.product, order].filter(Boolean).join(', ')}`
        : input.topic === 'product'
          ? [input.product, order].filter(Boolean).join(', ')
          : order
            ? `Question about ${order}`
            : 'General question';
  return (subject || TOPIC_LABEL[input.topic]).slice(0, 140);
}

export function firstName(name: string): string {
  return extractFirstName([name]).replace(/^Helper$/, 'Customer');
}

// --------------------------------------------------------------------------
// Discord text
// --------------------------------------------------------------------------

/** "batch:OD-FC-F4:2" reads as "batch 2 of OD-FC-F4". */
export function humanTag(tag: string): string {
  const m = tag.match(/^batch:(.+):(\d+)$/i);
  return m ? `batch ${m[2]} of ${m[1]}` : tag;
}

function orderLine(o: OrderSummary): string {
  const bits = [
    o.name,
    o.createdAt.slice(0, 10),
    o.financial ?? '',
    o.fulfillment ?? '',
    ...o.batchTags.map(humanTag),
    o.items.map((i) => `${i.quantity}x ${i.title}${i.sku ? ` (${i.sku})` : ''}`).join(', '),
  ].filter(Boolean);
  return escapeDiscord(bits.join(' · ')).slice(0, 400);
}

function identityLine(customer: CustomerContext, verifiedBy: string | null): string {
  if (verifiedBy) {
    const who =
      customer.match === 'matched'
        ? `Shopify customer, ${customer.ordersCount} order${customer.ordersCount === 1 ? '' : 's'}`
        : customer.match === 'multiple'
          ? 'several Shopify customers share this email: not linked'
          : 'no Shopify customer account (guest order)';
    return `email verified by order ${verifiedBy} · ${who}`;
  }
  if (customer.match === 'unverified') {
    return '**email not verified**: a Shopify customer uses this email, but no order of it was given. Ask for the order number before sharing any order details.';
  }
  if (customer.match === 'multiple') return 'email not verified · several Shopify customers share this email';
  if (customer.match === 'none') return 'email not verified · no Shopify customer with this email';
  return 'email not verified · Shopify not checked';
}

export function staffCard(opts: {
  env: SupportEnv;
  ref: string;
  input: NewTicketInput;
  customer: CustomerContext;
  order: OrderSummary | null;
  earlier?: Array<Pick<Ticket, 'ref' | 'status' | 'threadId'>>;
}): string {
  const {env, ref, input, customer, order, earlier = []} = opts;
  const role = env.SUPPORT_MOD_ROLE_ID ? ` <@&${env.SUPPORT_MOD_ROLE_ID}>` : '';
  const lines = [
    `**${ref}** · ${TOPIC_LABEL[input.topic]}${role}`,
    `From **${escapeDiscord(firstName(input.name))}** · ${identityLine(customer, order ? order.name : null)}`,
  ];
  if (!env.DISCORD_STAFF_METADATA_CHANNEL_ID) lines.push(`Email: ${escapeDiscord(input.email)}`);
  if (input.orderNumber) {
    lines.push(order ? `Order: ${orderLine(order)}` : `Order ${input.orderNumber}: not found for this email (typed by the customer, details withheld)`);
  }
  if (input.product) lines.push(`Product: ${escapeDiscord(input.product)}`);
  if (input.firmware) lines.push(`Firmware: ${escapeDiscord(input.firmware)}`);
  if (order && customer.match === 'matched') {
    const recent = customer.orders.filter((o) => o.name !== order.name).slice(0, 3);
    if (recent.length) lines.push('Recent orders:', ...recent.map((o) => `- ${orderLine(o)}`));
  }
  const others = earlier.filter((t) => t.ref !== ref).slice(0, 3);
  if (order && others.length) {
    lines.push(`Earlier tickets: ${others.map((t) => `[${t.ref}](<${threadUrl(env, t.threadId)}>) ${t.status}`).join(', ')}`);
  }
  lines.push('', 'Reply in this thread to answer. `// note` stays internal. `!waiting` asks the customer, `!answered`, `!close` closes, `!open` reopens.');
  if (resolveMode(env) === 'enforce') {
    lines.push(`Replies reach the customer after a moderator reacts ${approveEmoji(env)}. ⏳ marks a held reply; later messages and commands wait behind it.`);
  }
  return lines.join('\n');
}

/**
 * A customer message as posted in the thread: an escaped name header, then
 * the text in a block quote with masked links shown as their real target,
 * so it can never pass for a staff message or hide a link.
 */
export function customerPost(name: string, text: string): string[] {
  const body = neutralizeLinks(text) || '(attachment)';
  return chunkMessage(body, 1800).map((chunk, i) => `${i === 0 ? `**${escapeDiscord(firstName(name))} · customer**\n` : ''}>>> ${chunk}`);
}

// --------------------------------------------------------------------------
// Create, reply, close
// --------------------------------------------------------------------------

function run(deps: Deps, job: () => Promise<unknown>): Promise<unknown> | void {
  const p = job().catch((err) => console.warn('[support] background job failed', err instanceof Error ? err.message : 'error'));
  if (deps.defer) deps.defer(p);
  else return p;
}

async function postCustomerText(deps: Deps, threadId: string, name: string, text: string, files: OutboundFile[]) {
  const posts = customerPost(name, text);
  let last = '';
  for (let i = 0; i < posts.length; i++) {
    last = await deps.discord.post(threadId, posts[i]!, i === posts.length - 1 ? files : []);
  }
  return last;
}

/** Attachment metadata as Discord stored it (ids are needed to fetch them later). */
async function attachmentsOf(deps: Deps, threadId: string, messageId: string, files: OutboundFile[]) {
  if (!files.length) return [];
  try {
    const m = await deps.discord.message(threadId, messageId);
    return m.attachments.map((a) => ({id: a.id, filename: a.filename, size: a.size}));
  } catch {
    return files.map((f, i) => ({id: `local-${i}`, filename: f.name, size: f.data.byteLength}));
  }
}

function shopifyEntry(deps: Deps, t: Pick<Ticket, 'ref' | 'topic' | 'status' | 'createdAt' | 'threadId'>) {
  return {
    ref: t.ref,
    topic: t.topic,
    status: t.status,
    opened: new Date(t.createdAt).toISOString().slice(0, 10),
    link: threadUrl(deps.env, t.threadId),
  };
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79).trimEnd()}…` : flat;
}

export async function createTicket(deps: Deps, input: NewTicketInput, files: OutboundFile[] = []): Promise<Ticket> {
  const now = (deps.now ?? Date.now)();
  const fetcher = deps.fetcher ?? fetch;
  const ref = newTicketRef();
  // The email is only a claim. An order Shopify confirms for it is the proof
  // that links the Shopify customer and shows staff the order history.
  const order = input.orderNumber ? await ownedOrder(deps.env, input.orderNumber, input.email, null, fetcher) : null;
  const lookup = await lookupCustomer(deps.env, input.email, fetcher);
  const customer: CustomerContext = lookup.match === 'matched' && !order ? {match: 'unverified'} : lookup;
  const customerId = customer.match === 'matched' ? customer.customerId : null;
  const earlier = order ? await deps.store.ticketsByEmail(input.email, 4) : [];

  const threadId = await deps.discord.createThread({
    name: `${ref} ${input.topic} ${threadName(firstName(input.name))}`,
    card: staffCard({env: deps.env, ref, input, customer, order, earlier}),
  });
  const firstId = await postCustomerText(deps, threadId, input.name, input.message, files);
  const attachments = await attachmentsOf(deps, threadId, firstId, files);

  const ticket: Ticket = {
    ref,
    topic: input.topic,
    subject: subjectFor(input),
    status: 'open',
    name: input.name,
    email: input.email,
    orderNumber: input.orderNumber,
    orderVerified: Boolean(order),
    locked: false,
    metaMessageId: null,
    preview: preview(input.message),
    product: input.product,
    threadId,
    cursor: firstId,
    customerId,
    customerMatch: customer.match,
    linkVersion: 1,
    createdAt: now,
    updatedAt: now,
    lastCustomerAt: now,
    lastStaffAt: null,
    customerSeenAt: now,
    notifiedAt: null,
    syncedAt: now,
    closedAt: null,
  };
  await deps.store.insertTicket(ticket);
  await deps.store.addMessage({ref, discordId: firstId, role: 'customer', author: firstName(input.name), body: input.message, attachments, createdAt: now});

  const metaChannel = deps.env.DISCORD_STAFF_METADATA_CHANNEL_ID;
  if (metaChannel) {
    await run(deps, async () => {
      const id = await deps.discord.postToChannel(
        metaChannel,
        [
          `**${ref}** · ${TOPIC_LABEL[input.topic]}`,
          `${escapeDiscord(cleanText(input.name))} <${escapeDiscord(input.email)}> · ${order ? `verified by order ${order.name}` : 'email not verified'}`,
          customerId ? `Shopify: ${customerAdminUrl(deps.env, customerId) ?? customerId}` : `Shopify: ${customer.match}`,
          `Thread: ${threadUrl(deps.env, threadId)}`,
        ].join('\n'),
      );
      await deps.store.updateTicket(ref, {metaMessageId: id});
    });
  }
  if (customerId) {
    await run(deps, () => recordOnCustomer(deps.env, customerId, shopifyEntry(deps, ticket), {tag: true}, fetcher));
  }
  return ticket;
}

export type ReplyError = 'too_short' | 'too_long' | 'filtered' | 'locked';
export type ReplyResult = {ok: true; ticket: Ticket} | {ok: false; error: ReplyError};

async function markLocked(deps: Deps, ticket: Ticket, now: number): Promise<Ticket> {
  const patch = {locked: true, status: 'closed' as TicketStatus, closedAt: ticket.closedAt ?? now, updatedAt: now};
  await deps.store.updateTicket(ticket.ref, patch);
  if (!ticket.locked) {
    await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: 'locked_by_team', attachments: [], createdAt: now});
  }
  return {...ticket, ...patch};
}

export async function addCustomerReply(deps: Deps, ticket: Ticket, rawText: string, files: OutboundFile[] = []): Promise<ReplyResult> {
  if (ticket.locked) return {ok: false, error: 'locked'};
  const text = normalizeText(rawText);
  if (!text && !files.length) return {ok: false, error: 'too_short'};
  if (text.length > LIMITS.message) return {ok: false, error: 'too_long'};
  const scrubbed = scrubForDiscord(text);
  if (scrubbed.blocked) return {ok: false, error: 'filtered'};
  const now = (deps.now ?? Date.now)();

  const reopening = ticket.status === 'closed';
  let id: string;
  try {
    if (reopening) await deps.discord.post(ticket.threadId, `*${ticket.ref}: the customer reopened this ticket.*`);
    id = await postCustomerText(deps, ticket.threadId, ticket.name, scrubbed.content, files);
  } catch (err) {
    // The team locked or deleted the thread since the last sync.
    if (err instanceof DiscordError && (err.status === 403 || err.status === 404)) {
      await markLocked(deps, ticket, now);
      return {ok: false, error: 'locked'};
    }
    throw err;
  }
  const attachments = await attachmentsOf(deps, ticket.threadId, id, files);
  if (reopening) {
    await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: 'reopened_by_you', attachments: [], createdAt: now});
  }
  await deps.store.addMessage({ref: ticket.ref, discordId: id, role: 'customer', author: firstName(ticket.name), body: scrubbed.content, attachments, createdAt: now});
  const patch = {status: 'open' as TicketStatus, closedAt: null, updatedAt: now, lastCustomerAt: now, customerSeenAt: now};
  await deps.store.updateTicket(ticket.ref, patch);
  const next = {...ticket, ...patch};
  if (reopening && ticket.customerId) {
    await run(deps, () => recordOnCustomer(deps.env, ticket.customerId!, shopifyEntry(deps, next), {}, deps.fetcher ?? fetch));
  }
  return {ok: true, ticket: next};
}

type CloseBy = 'you' | 'team' | 'auto' | 'idle';

const CLOSE_EVENT: Record<CloseBy, string> = {you: 'closed_by_you', team: 'closed_by_team', auto: 'auto_closed', idle: 'idle_closed'};
const CLOSE_NOTE: Record<Exclude<CloseBy, 'team'>, string> = {
  you: 'the customer marked it solved',
  auto: 'no answer from the customer for 30 days',
  idle: 'no activity for 90 days',
};

export async function closeTicket(deps: Deps, ticket: Ticket, by: CloseBy): Promise<Ticket> {
  if (ticket.status === 'closed') return ticket;
  const now = (deps.now ?? Date.now)();
  const patch = {status: 'closed' as TicketStatus, closedAt: now, updatedAt: now};
  await deps.store.updateTicket(ticket.ref, patch);
  await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: CLOSE_EVENT[by], attachments: [], createdAt: now});
  const next = {...ticket, ...patch};
  await run(deps, async () => {
    if (by !== 'team') await deps.discord.post(ticket.threadId, `*${ticket.ref} closed: ${CLOSE_NOTE[by]}. A reply from the customer reopens it.*`);
    await deps.discord.setArchived(ticket.threadId, true);
  });
  if (ticket.customerId) {
    await run(deps, () => recordOnCustomer(deps.env, ticket.customerId!, shopifyEntry(deps, next), {}, deps.fetcher ?? fetch));
  }
  return next;
}

/** New link version: every older resume link and cookie entry stops working. */
export async function resetLink(deps: Deps, ticket: Ticket): Promise<Ticket> {
  const linkVersion = ticket.linkVersion + 1;
  await deps.store.updateTicket(ticket.ref, {linkVersion});
  return {...ticket, linkVersion};
}

// --------------------------------------------------------------------------
// Discord -> site
// --------------------------------------------------------------------------

function companyPhones(env: SupportEnv): string[] {
  return env.PUBLIC_COMPANY_TEL ? [env.PUBLIC_COMPANY_TEL] : [];
}

const COMMAND_RE = /^!(close|closed|solved|waiting|wait|answered|open|reopen)\b/i;
const RECENT_WINDOW = 100;
const HELD_EMOJI = '⏳';

export type SyncResult = {ticket: Ticket; added: number; held: number};

/**
 * Read the ticket's thread and bring the ticket up to date. Throttled per
 * ticket unless `force`; a Discord failure leaves the ticket as it was.
 *
 * - New messages (after the cursor) are handled in thread order, exactly
 *   once: bot posts and `//` notes are skipped, commands set the status,
 *   replies are scrubbed and copied. A reply the moderation gate holds
 *   stops the pass there: the cursor stays before it, so it and everything
 *   after it are handled, in order, once it is approved.
 * - Replies already copied are re-checked against the latest messages: a
 *   deleted one is withdrawn, an edited one updated (in enforce mode an
 *   edit after approval withdraws it instead, for the team to repost).
 * - A locked or deleted thread closes the ticket for good.
 */
export async function syncTicket(deps: Deps, ticket: Ticket, opts: {force?: boolean} = {}): Promise<SyncResult> {
  const now = (deps.now ?? Date.now)();
  if (!opts.force && ticket.syncedAt && now - ticket.syncedAt < SYNC_THROTTLE_MS) return {ticket, added: 0, held: 0};

  let thread;
  let recent: DiscordMessage[] = [];
  let fresh: DiscordMessage[] = [];
  try {
    thread = await deps.discord.thread(ticket.threadId);
    if (thread) {
      recent = await deps.discord.messagesAfter(ticket.threadId, null, RECENT_WINDOW);
      const covered = !ticket.cursor || recent.length < RECENT_WINDOW || compareSnowflakes(recent[0]!.id, ticket.cursor) <= 0;
      fresh = covered
        ? recent.filter((m) => !ticket.cursor || compareSnowflakes(m.id, ticket.cursor) > 0)
        : await deps.discord.messagesAfter(ticket.threadId, ticket.cursor, RECENT_WINDOW);
    }
  } catch (err) {
    console.warn('[support] sync read failed', ticket.ref, err instanceof Error ? err.message : 'error');
    return {ticket, added: 0, held: 0};
  }

  // A deleted thread has nothing left to read: closed and locked.
  if (!thread) {
    const locked = ticket.locked ? ticket : await markLocked(deps, ticket, now);
    await deps.store.updateTicket(ticket.ref, {syncedAt: now});
    if (!ticket.locked && ticket.customerId) {
      await run(deps, () => recordOnCustomer(deps.env, ticket.customerId!, shopifyEntry(deps, locked), {}, deps.fetcher ?? fetch));
    }
    return {ticket: {...locked, syncedAt: now}, added: 0, held: 0};
  }

  let status = ticket.status;
  let lastStaffAt = ticket.lastStaffAt;
  let closedAt = ticket.closedAt;
  let cursor = ticket.cursor;
  let added = 0;
  let held = 0;
  const events: Array<{body: string; at: number}> = [];

  for (const m of fresh) {
    const text = m.content.trim();
    const at = Date.parse(m.createdAt) || now;
    const command = m.author.bot || text.startsWith('//') ? undefined : text.match(COMMAND_RE)?.[1]?.toLowerCase();
    if (!m.author.bot && !text.startsWith('//') && !command) {
      const decision = await decide(deps.env, deps.discord, ticket.threadId, m);
      if (!decision.approved) {
        held = fresh.filter((x) => !x.author.bot && compareSnowflakes(x.id, m.id) >= 0).length;
        if (!m.reactions.some((r) => r.emoji === HELD_EMOJI && r.me)) {
          deps.discord.react(ticket.threadId, m.id, HELD_EMOJI).catch(() => {});
        }
        break;
      }
      const scrubbed = scrubForPublic(text, {keepPhones: companyPhones(deps.env)});
      if (scrubbed.blocked) {
        console.warn('[support] reply blocked by scrubber', ticket.ref, m.id, scrubbed.reasons.join(','));
      } else if (scrubbed.content || m.attachments.length) {
        const inserted = await deps.store.addMessage({
          ref: ticket.ref,
          discordId: m.id,
          role: 'staff',
          author: extractFirstName([m.author.globalName, m.author.username]).replace(/^Helper$/, 'OpenDrone'),
          body: scrubbed.content,
          attachments: m.attachments.map((a) => ({id: a.id, filename: a.filename, size: a.size})),
          createdAt: at,
        });
        if (inserted) added++;
        if (status === 'closed') events.push({body: 'reopened_by_team', at});
        status = status === 'waiting' ? 'waiting' : 'answered';
        closedAt = null;
        lastStaffAt = Math.max(lastStaffAt ?? 0, at);
      }
    } else if (command) {
      const wasClosed = status === 'closed';
      if (command.startsWith('clos') || command === 'solved') {
        if (!wasClosed) {
          status = 'closed';
          closedAt = at;
          events.push({body: 'closed_by_team', at});
        }
      } else {
        status = command.startsWith('wait') ? 'waiting' : command === 'answered' ? 'answered' : 'open';
        closedAt = null;
        if (wasClosed) events.push({body: 'reopened_by_team', at});
      }
      deps.discord.react(ticket.threadId, m.id, '👍').catch(() => {});
    }
    cursor = m.id;
  }

  // Edits and deletions of replies already copied, within the recent window.
  if (recent.length) {
    const byId = new Map(recent.map((m) => [m.id, m]));
    const enforce = resolveMode(deps.env) === 'enforce';
    for (const stored of await deps.store.staffMessagesSince(ticket.ref, recent[0]!.id)) {
      const live = byId.get(stored.discordId!);
      if (!live) {
        await deps.store.deleteMessage(stored.seq);
        events.push({body: 'reply_withdrawn', at: now});
        continue;
      }
      if (!live.editedAt) continue;
      const scrubbed = scrubForPublic(live.content.trim(), {keepPhones: companyPhones(deps.env)});
      if (scrubbed.content === stored.body) continue;
      if (enforce || scrubbed.blocked) {
        await deps.store.deleteMessage(stored.seq);
        events.push({body: 'reply_withdrawn', at: now});
        deps.discord
          .post(ticket.threadId, `*${ticket.ref}: a reply edited after it was sent was withdrawn from the customer's page. Post it again to send it.*`)
          .catch(() => {});
      } else {
        await deps.store.updateMessageBody(stored.seq, scrubbed.content);
      }
    }
  }

  // Locked in Discord: what was said before the lock is copied above, then
  // the ticket closes for good. Unlocked again: replies are possible again.
  const lockedNow = thread.locked;
  if (lockedNow && !ticket.locked) {
    if (status !== 'closed') closedAt = now;
    status = 'closed';
    events.push({body: 'locked_by_team', at: now});
  }
  for (const e of events) {
    await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: e.body, attachments: [], createdAt: e.at});
  }
  const changed = status !== ticket.status || added > 0 || events.length > 0;
  const patch = {cursor, syncedAt: now, status, closedAt, lastStaffAt, locked: lockedNow, ...(changed ? {updatedAt: now} : {})};
  await deps.store.updateTicket(ticket.ref, patch);
  const next = {...ticket, ...patch};
  if (status !== ticket.status && ticket.customerId) {
    await run(deps, () => recordOnCustomer(deps.env, ticket.customerId!, shopifyEntry(deps, next), {}, deps.fetcher ?? fetch));
  }
  if (status === 'closed' && ticket.status !== 'closed') {
    await run(deps, () => deps.discord.setArchived(ticket.threadId, true));
  }
  return {ticket: next, added, held};
}

// --------------------------------------------------------------------------
// Find my ticket
// --------------------------------------------------------------------------

/**
 * Tickets for an email plus one proof:
 * - the ticket's reference: that one ticket, when it was opened with this
 *   email (a reference is random, 40 bits, and shown only to its customer
 *   and the team);
 * - an order number Shopify confirms for this email: the tickets filed with
 *   that order. An order number typed into a ticket proves nothing.
 * Shopify is asked on every order-number attempt, so the answer time does
 * not reveal whether the email has tickets.
 */
export async function findTickets(deps: Deps, email: string, key: string): Promise<Ticket[]> {
  const mail = email.trim().toLowerCase();
  if (!isEmail(mail)) return [];
  const ref = parseTicketRef(key);
  if (ref) {
    const t = await deps.store.getTicket(ref);
    return t && t.email === mail ? [t] : [];
  }
  const order = normalizeOrderNumber(key);
  if (!order) return [];
  const [owned, all] = await Promise.all([
    ownedOrder(deps.env, order, mail, null, deps.fetcher ?? fetch),
    deps.store.ticketsByEmail(mail, 50),
  ]);
  if (!owned) return [];
  return all.filter((t) => t.orderNumber === order);
}

// --------------------------------------------------------------------------
// Scheduled jobs
// --------------------------------------------------------------------------

export async function freshResumeUrl(deps: Deps, ticket: Ticket): Promise<string> {
  const token = await signResumeToken(deps.env, ticket.ref, ticket.linkVersion, (deps.now ?? Date.now)());
  return resumeUrl(deps.origin, token);
}

/**
 * Delete tickets closed more than 24 months ago: the Shopify entry first,
 * then the Discord thread and the staff-metadata post, then the rows. A
 * ticket whose Shopify entry could not be removed stays for the next run.
 */
export async function cleanupExpired(deps: Deps, opts: {dryRun?: boolean; limit?: number} = {}): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const expired = await deps.store.expiredTickets(now - RETENTION_MS, opts.limit ?? 25);
  if (opts.dryRun) return expired.map((t) => t.ref);
  const done: string[] = [];
  for (const t of expired) {
    try {
      if (t.customerId && shopifyWritesEnabled(deps.env)) {
        const removed = await recordOnCustomer(deps.env, t.customerId, shopifyEntry(deps, t), {remove: true}, deps.fetcher ?? fetch);
        if (!removed) continue;
      }
      await deps.discord.deleteThread(t.threadId);
      const meta = deps.env.DISCORD_STAFF_METADATA_CHANNEL_ID;
      if (t.metaMessageId && meta) await deps.discord.deleteMessage(meta, t.metaMessageId);
      await deps.store.deleteTicket(t.ref);
      done.push(t.ref);
    } catch (err) {
      console.warn('[support] cleanup failed', t.ref, err instanceof Error ? err.message : 'error');
    }
  }
  return done;
}

export type JobReport = {synced: number; notified: number; autoClosed: string[]; deleted: string[]};

export async function runScheduled(deps: Deps): Promise<JobReport> {
  const now = (deps.now ?? Date.now)();
  const report: JobReport = {synced: 0, notified: 0, autoClosed: [], deleted: []};

  for (const t of await deps.store.ticketsToSync(now - 60 * DAY, 20)) {
    const {ticket} = await syncTicket(deps, t, {force: true});
    report.synced++;
    const seen = Math.max(ticket.customerSeenAt ?? 0, ticket.notifiedAt ?? 0);
    if (ticket.status !== 'closed' && ticket.lastStaffAt && ticket.lastStaffAt > seen && now - ticket.lastStaffAt >= NOTIFY_DELAY_MS) {
      const sent = await sendReplyNotice(deps.env, ticket.email, ticket.ref, await freshResumeUrl(deps, ticket), deps.fetcher ?? fetch);
      if (sent) {
        await deps.store.updateTicket(ticket.ref, {notifiedAt: now});
        report.notified++;
      }
    }
  }

  for (const t of await deps.store.staleTickets(now - AUTO_CLOSE_MS, 20)) {
    await closeTicket(deps, t, 'auto');
    report.autoClosed.push(t.ref);
  }
  // Anything else untouched for 90 days (an unanswered ticket included)
  // closes too, so every ticket reaches the 24-month deletion.
  for (const t of await deps.store.idleTickets(now - IDLE_CLOSE_MS, 20)) {
    await closeTicket(deps, t, 'idle');
    report.autoClosed.push(t.ref);
  }

  report.deleted = await cleanupExpired(deps, {limit: 10});
  await deps.store.pruneRate(now - DAY).catch(() => {});
  return report;
}

// --------------------------------------------------------------------------
// What the browser sees
// --------------------------------------------------------------------------

export type PublicMessage = {
  seq: number;
  role: TicketMessage['role'];
  author: string;
  body: string;
  attachments: Array<{id: string; filename: string; size: number; href: string | null}>;
  at: number;
};

export type PublicTicket = {
  ref: string;
  topic: TicketTopic;
  subject: string;
  preview: string;
  status: TicketStatus;
  locked: boolean;
  name: string;
  orderNumber: string | null;
  product: string | null;
  createdAt: number;
  updatedAt: number;
};

/** The ticket without email, Discord or Shopify identifiers. */
export function publicTicket(t: Ticket): PublicTicket {
  return {
    ref: t.ref,
    topic: t.topic,
    subject: t.subject,
    preview: t.preview,
    status: t.status,
    locked: t.locked,
    name: firstName(t.name),
    orderNumber: t.orderNumber,
    product: t.product,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

export function publicMessage(m: TicketMessage): PublicMessage {
  return {
    seq: m.seq,
    role: m.role,
    author: m.author,
    body: m.body,
    attachments: m.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      href: m.discordId && /^\d+$/.test(a.id) ? `/api/support/tickets/${m.ref}/files/${m.discordId}/${a.id}` : null,
    })),
    at: m.createdAt,
  };
}

/** Conversation order: by time, then by arrival. */
export function byTime(a: Pick<PublicMessage, 'at' | 'seq'>, b: Pick<PublicMessage, 'at' | 'seq'>): number {
  return a.at - b.at || a.seq - b.seq;
}
