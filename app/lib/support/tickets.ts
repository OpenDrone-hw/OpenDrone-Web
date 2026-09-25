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
 *   closed    solved: by the customer, by `!close`, by locking the thread,
 *             or after 30 days without an answer to a reply
 *
 * Staff work in the thread: every message is relayed to the customer after
 * the scrubber (and the moderation gate when enabled), except messages that
 * start with `//` (internal notes) and the commands `!waiting`, `!answered`,
 * `!close` and `!open`.
 */
import {chunkMessage, cleanText, threadUrl, type DiscordClient, type DiscordEnv, type DiscordMessage, type OutboundFile} from './discord.ts';
import {cursorAfter, decide, type ModerationEnv} from './moderation.ts';
import {sendReplyNotice} from './notify.ts';
import {extractFirstName, scrubForDiscord, scrubForPublic} from './scrubber.ts';
import {
  customerAdminUrl,
  isEmail,
  lookupCustomer,
  normalizeOrderNumber,
  ownedOrder,
  recordOnCustomer,
  type CustomerContext,
  type OrderSummary,
  type ShopifyEnv,
} from './shopify.ts';
import type {SupportStore, Ticket, TicketMessage, TicketStatus, TicketTopic} from './store.ts';
import {newTicketRef, parseTicketRef, resumeUrl, signResumeToken} from './tokens.ts';

export type SupportEnv = DiscordEnv &
  ModerationEnv &
  ShopifyEnv & {
    SUPPORT_SESSION_SECRET?: string;
    SESSION_SECRET?: string;
    SUPPORT_EMAIL_NOTIFY_ENABLED?: string;
    RESEND_API_KEY?: string;
    SUPPORT_FROM_EMAIL?: string;
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

export const TOPICS: TicketTopic[] = ['order', 'product', 'warranty', 'other'];

const TOPIC_LABEL: Record<TicketTopic, string> = {
  order: 'Order or preorder',
  product: 'Product or technical',
  warranty: 'Warranty or return',
  other: 'Other',
};

export const LIMITS = {
  name: 80,
  product: 80,
  firmware: 60,
  message: 4000,
  minMessage: 10,
};

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 730 * DAY;
export const AUTO_CLOSE_MS = 30 * DAY;
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

/** Which fields a topic asks for, and which of them are required. */
export const TOPIC_FIELDS: Record<TicketTopic, {order: 'required' | 'optional' | null; product: 'required' | 'optional' | null; firmware: boolean}> = {
  order: {order: 'required', product: null, firmware: false},
  product: {order: 'optional', product: 'required', firmware: true},
  warranty: {order: 'required', product: 'required', firmware: false},
  other: {order: 'optional', product: null, firmware: false},
};

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

  const rawMessage = String(form.get('message') ?? '').trim();
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

function orderLine(o: OrderSummary): string {
  const bits = [
    o.name,
    o.createdAt.slice(0, 10),
    o.financial ?? '',
    o.fulfillment ?? '',
    ...o.batchTags,
    o.items.map((i) => `${i.quantity}x ${i.title}${i.sku ? ` (${i.sku})` : ''}`).join(', '),
  ].filter(Boolean);
  return bits.join(' · ').slice(0, 300);
}

export function staffCard(opts: {
  env: SupportEnv;
  ref: string;
  input: NewTicketInput;
  customer: CustomerContext;
  order: OrderSummary | null;
}): string {
  const {env, ref, input, customer, order} = opts;
  const role = env.SUPPORT_MOD_ROLE_ID ? ` <@&${env.SUPPORT_MOD_ROLE_ID}>` : '';
  const shop =
    customer.match === 'matched'
      ? `Shopify customer, ${customer.ordersCount} order${customer.ordersCount === 1 ? '' : 's'}`
      : customer.match === 'none'
        ? 'no Shopify customer with this email'
        : customer.match === 'multiple'
          ? 'several Shopify customers share this email: not linked'
          : 'Shopify not checked';
  const lines = [
    `**${ref}** · ${TOPIC_LABEL[input.topic]}${role}`,
    `From **${firstName(input.name)}** · ${shop}`,
  ];
  if (!env.DISCORD_STAFF_METADATA_CHANNEL_ID) lines.push(`Email: ${input.email}`);
  if (input.orderNumber) {
    lines.push(
      order
        ? `Order: ${orderLine(order)}`
        : `Order ${input.orderNumber}: not found for this email (details withheld)`,
    );
  }
  if (input.product) lines.push(`Product: ${input.product}`);
  if (input.firmware) lines.push(`Firmware: ${input.firmware}`);
  if (customer.match === 'matched') {
    const recent = customer.orders.filter((o) => o.name !== order?.name).slice(0, 3);
    if (recent.length) lines.push('Recent orders:', ...recent.map((o) => `- ${orderLine(o)}`));
    const earlier = customer.tickets.filter((t) => t.ref !== ref).slice(0, 3);
    if (earlier.length) lines.push(`Earlier tickets: ${earlier.map((t) => `${t.ref} (${t.status})`).join(', ')}`);
  }
  lines.push(
    '',
    'Reply in this thread to answer. `// note` stays internal. `!waiting` asks the customer, `!close` closes, `!open` reopens.',
  );
  return lines.join('\n');
}

function customerPrefix(name: string): string {
  return `**${firstName(name)} · customer**\n`;
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
  const chunks = chunkMessage(text, 1850);
  let last: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    last = await deps.discord.post(threadId, (i === 0 ? customerPrefix(name) : '') + chunks[i], isLast ? files : []);
  }
  return last!;
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

export async function createTicket(deps: Deps, input: NewTicketInput, files: OutboundFile[] = []): Promise<Ticket> {
  const now = (deps.now ?? Date.now)();
  const fetcher = deps.fetcher ?? fetch;
  const ref = newTicketRef();
  const customer = await lookupCustomer(deps.env, input.email, fetcher);
  const customerId = customer.match === 'matched' ? customer.customerId : null;
  const order = input.orderNumber ? await ownedOrder(deps.env, input.orderNumber, input.email, customerId, fetcher) : null;

  const threadId = await deps.discord.createThread({
    name: `${ref} ${input.topic} ${firstName(input.name)}`,
    card: staffCard({env: deps.env, ref, input, customer, order}),
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
  await deps.store.addMessage({
    ref,
    discordId: firstId,
    role: 'customer',
    author: firstName(input.name),
    body: input.message,
    attachments,
    createdAt: now,
  });

  const metaChannel = deps.env.DISCORD_STAFF_METADATA_CHANNEL_ID;
  if (metaChannel) {
    await run(deps, () =>
      deps.discord.postToChannel(
        metaChannel,
        [
          `**${ref}** · ${TOPIC_LABEL[input.topic]}`,
          `${cleanText(input.name)} <${input.email}>`,
          customerId ? `Shopify: ${customerAdminUrl(deps.env, customerId) ?? customerId}` : `Shopify: ${customer.match}`,
          `Thread: ${threadUrl(deps.env, threadId)}`,
        ].join('\n'),
      ),
    );
  }
  if (customerId) {
    await run(deps, () => recordOnCustomer(deps.env, customerId, shopifyEntry(deps, ticket), {}, fetcher));
  }
  return ticket;
}

export type ReplyResult = {ok: true; ticket: Ticket} | {ok: false; error: 'too_short' | 'too_long' | 'filtered'};

export async function addCustomerReply(deps: Deps, ticket: Ticket, rawText: string, files: OutboundFile[] = []): Promise<ReplyResult> {
  const text = rawText.trim();
  if (!text && !files.length) return {ok: false, error: 'too_short'};
  if (text.length > LIMITS.message) return {ok: false, error: 'too_long'};
  const scrubbed = scrubForDiscord(text);
  if (scrubbed.blocked) return {ok: false, error: 'filtered'};
  const now = (deps.now ?? Date.now)();

  const reopening = ticket.status === 'closed';
  if (reopening) {
    await deps.discord.post(ticket.threadId, `*${ticket.ref}: the customer reopened this ticket.*`);
  }
  const id = await postCustomerText(deps, ticket.threadId, ticket.name, scrubbed.content || '(attachment)', files);
  const attachments = await attachmentsOf(deps, ticket.threadId, id, files);
  if (reopening) {
    await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: 'reopened_by_you', attachments: [], createdAt: now});
  }
  await deps.store.addMessage({
    ref: ticket.ref,
    discordId: id,
    role: 'customer',
    author: firstName(ticket.name),
    body: scrubbed.content,
    attachments,
    createdAt: now,
  });
  const patch = {status: 'open' as TicketStatus, closedAt: null, updatedAt: now, lastCustomerAt: now, customerSeenAt: now};
  await deps.store.updateTicket(ticket.ref, patch);
  const next = {...ticket, ...patch};
  if (reopening && ticket.customerId) {
    await run(deps, () => recordOnCustomer(deps.env, ticket.customerId!, shopifyEntry(deps, next), {}, deps.fetcher ?? fetch));
  }
  return {ok: true, ticket: next};
}

type CloseBy = 'you' | 'team' | 'auto';

export async function closeTicket(deps: Deps, ticket: Ticket, by: CloseBy): Promise<Ticket> {
  if (ticket.status === 'closed') return ticket;
  const now = (deps.now ?? Date.now)();
  const patch = {status: 'closed' as TicketStatus, closedAt: now, updatedAt: now};
  await deps.store.updateTicket(ticket.ref, patch);
  await deps.store.addMessage({
    ref: ticket.ref,
    discordId: null,
    role: 'system',
    author: '',
    body: by === 'you' ? 'closed_by_you' : by === 'team' ? 'closed_by_team' : 'auto_closed',
    attachments: [],
    createdAt: now,
  });
  const next = {...ticket, ...patch};
  await run(deps, async () => {
    if (by !== 'team') {
      const why = by === 'you' ? 'the customer marked it solved' : 'no answer from the customer for 30 days';
      await deps.discord.post(ticket.threadId, `*${ticket.ref} closed: ${why}. A reply from the customer reopens it.*`);
    }
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

const COMMAND_RE = /^!(close|closed|solved|waiting|wait|answered|open|reopen)\b/i;

export type SyncResult = {ticket: Ticket; added: number; held: number};

/**
 * Read the ticket's thread since its cursor and copy the team's replies to
 * the ticket. Throttled per ticket unless `force`; Discord failures leave
 * the ticket as it was.
 */
export async function syncTicket(deps: Deps, ticket: Ticket, opts: {force?: boolean} = {}): Promise<SyncResult> {
  const now = (deps.now ?? Date.now)();
  if (!opts.force && ticket.syncedAt && now - ticket.syncedAt < SYNC_THROTTLE_MS) {
    return {ticket, added: 0, held: 0};
  }
  let messages: DiscordMessage[];
  try {
    messages = await deps.discord.messagesAfter(ticket.threadId, ticket.cursor);
  } catch (err) {
    console.warn('[support] sync read failed', ticket.ref, err instanceof Error ? err.message : 'error');
    return {ticket, added: 0, held: 0};
  }

  let status = ticket.status;
  let lastStaffAt = ticket.lastStaffAt;
  let closedAt = ticket.closedAt;
  let added = 0;
  const held = new Set<string>();
  const events: Array<{body: string; at: number}> = [];

  for (const m of messages) {
    if (m.author.bot) continue;
    const text = m.content.trim();
    const at = Date.parse(m.createdAt) || now;
    if (text.startsWith('//')) continue;
    const command = text.match(COMMAND_RE)?.[1]?.toLowerCase();
    if (command) {
      const wasClosed = status === 'closed';
      if (command.startsWith('clos') || command === 'solved') {
        if (!wasClosed) {
          status = 'closed';
          closedAt = at;
          events.push({body: 'closed_by_team', at});
        }
      } else if (command.startsWith('wait')) {
        status = 'waiting';
        closedAt = null;
        if (wasClosed) events.push({body: 'reopened_by_team', at});
      } else if (command === 'answered') {
        status = 'answered';
        closedAt = null;
      } else {
        status = 'open';
        closedAt = null;
        if (wasClosed) events.push({body: 'reopened_by_team', at});
      }
      deps.discord.react(ticket.threadId, m.id, '👍').catch(() => {});
      continue;
    }
    const decision = await decide(deps.env, deps.discord, ticket.threadId, m);
    if (!decision.approved) {
      held.add(m.id);
      continue;
    }
    // A reply after a held one waits too, so the customer reads them in order.
    if (held.size) {
      held.add(m.id);
      continue;
    }
    const scrubbed = scrubForPublic(text);
    if (scrubbed.blocked) {
      console.warn('[support] reply blocked by scrubber', ticket.ref, m.id, scrubbed.reasons.join(','));
      continue;
    }
    if (!scrubbed.content && !m.attachments.length) continue;
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

  // Staff closing the thread in Discord (lock, or delete) closes the ticket.
  if (status !== 'closed') {
    const thread = await deps.discord.thread(ticket.threadId).catch(() => undefined);
    if (thread === null || thread?.locked) {
      status = 'closed';
      closedAt = now;
      events.push({body: 'closed_by_team', at: now});
    }
  }

  for (const e of events) {
    await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: e.body, attachments: [], createdAt: e.at});
  }
  const cursor = cursorAfter(messages, held, ticket.cursor);
  const changed = status !== ticket.status || added > 0 || events.length > 0;
  const patch = {
    cursor,
    syncedAt: now,
    status,
    closedAt,
    lastStaffAt,
    ...(changed ? {updatedAt: now} : {}),
  };
  await deps.store.updateTicket(ticket.ref, patch);
  const next = {...ticket, ...patch};
  if (status !== ticket.status && ticket.customerId) {
    await run(deps, () => recordOnCustomer(deps.env, ticket.customerId!, shopifyEntry(deps, next), {}, deps.fetcher ?? fetch));
  }
  if (status === 'closed' && ticket.status !== 'closed') {
    await run(deps, () => deps.discord.setArchived(ticket.threadId, true));
  }
  return {ticket: next, added, held: held.size};
}

// --------------------------------------------------------------------------
// Find my ticket
// --------------------------------------------------------------------------

/**
 * Tickets for an email plus one proof: a ticket reference of that email, or
 * an order number (a ticket filed with it, or a Shopify order of that
 * email, which proves the same thing Shopify's own order lookup does).
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
  const all = await deps.store.ticketsByEmail(mail);
  if (!all.length) return [];
  if (all.some((t) => t.orderNumber === order)) return all;
  const owned = await ownedOrder(deps.env, order, mail, null, deps.fetcher ?? fetch);
  return owned ? all : [];
}

// --------------------------------------------------------------------------
// Scheduled jobs
// --------------------------------------------------------------------------

export async function freshResumeUrl(deps: Deps, ticket: Ticket): Promise<string> {
  const token = await signResumeToken(deps.env, ticket.ref, ticket.linkVersion, (deps.now ?? Date.now)());
  return resumeUrl(deps.origin, token);
}

/** Delete tickets closed more than 24 months ago: Discord thread, Shopify entry, rows. */
export async function cleanupExpired(deps: Deps, opts: {dryRun?: boolean; limit?: number} = {}): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const expired = await deps.store.expiredTickets(now - RETENTION_MS, opts.limit ?? 25);
  if (opts.dryRun) return expired.map((t) => t.ref);
  const done: string[] = [];
  for (const t of expired) {
    try {
      await deps.discord.deleteThread(t.threadId);
      if (t.customerId) await recordOnCustomer(deps.env, t.customerId, shopifyEntry(deps, t), {remove: true}, deps.fetcher ?? fetch);
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

  const active = await deps.store.ticketsToSync(now - 60 * DAY, 20);
  for (const t of active) {
    const {ticket} = await syncTicket(deps, t, {force: true});
    report.synced++;
    const seen = Math.max(ticket.customerSeenAt ?? 0, ticket.notifiedAt ?? 0);
    if (
      ticket.status !== 'closed' &&
      ticket.lastStaffAt &&
      ticket.lastStaffAt > seen &&
      now - ticket.lastStaffAt >= NOTIFY_DELAY_MS
    ) {
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

  report.deleted = await cleanupExpired(deps, {limit: 10});
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
  status: TicketStatus;
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
    status: t.status,
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
