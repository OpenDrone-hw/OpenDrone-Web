/**
 * The community route. A customer who ticked the consent box on a product or
 * general question may get it posted, anonymised, to the public #help forum
 * when ChatFPV labels it `community` and none of the hard rules below holds.
 * Member replies are copied back to the ticket as `community` messages.
 * Everything else stays with the team. Behind SUPPORT_COMMUNITY_ROUTE.
 *
 * The hard rules decide first and cannot be overridden by the AI label: an
 * order number, address, payment, warranty, refund, personal data or an
 * internal matter forces the team route.
 */
import {customerBody, escapeDiscord} from './discord.ts';
import {redactTicketText} from './ai-drafts.ts';
import {scrubForPublic} from './scrubber.ts';
import type {Route, Ticket} from './store.ts';
import type {Deps} from './tickets.ts';
import {communityEnabled} from './flags.ts';

// TODO-LEGAL: placeholder wording, not final text. The operations repo legal
// drafting flow (documents/storefront-legal/) replaces these strings, and the
// privacy notice must name the public post, its anonymisation and its deletion.
export const COMMUNITY_CONSENT_LABEL = 'Let the community help (posted without your name)';
// TODO-LEGAL: placeholder footer on every community post.
export const COMMUNITY_POST_FOOTER = '*Posted from an OpenDrone support request without the asker\'s name. Replies here reach the asker and the OpenDrone team.*';
// TODO-LEGAL: placeholder note posted when the team takes a question back.
export const COMMUNITY_TAKEOVER_NOTE = '*The OpenDrone team has taken over this question and will answer the asker directly.*';

/** Community routing is for these topics only. */
export const COMMUNITY_TOPICS: ReadonlySet<string> = new Set(['product', 'other']);

const RULES: Array<{reason: string; re: RegExp}> = [
  {reason: 'order', re: /\b(orders?|pre-?orders?|bestelling\w*|commandes?|bestellung\w*|batch|tracking|shipments?|shipping|shipped|deliver\w*|verzending|levering|livraison|expédi\w*)\b|#\s?\d{3,}/i},
  {
    reason: 'address',
    re: /\b(address|adres|adresse|street|straat|rue|stra(?:ß|ss)e|post(?:al|code)|zip ?code|apt|apartment|city|stad|ville)\b|\b\d{4,5}\s+\p{Lu}\p{Ll}+/iu,
  },
  {reason: 'payment', re: /\b(pay|paid|payments?|betal\w*|paiement|invoices?|factuur|facture|vat|btw|tva|iban|credit card|visa|mastercard|paypal|bank|charge-?back|price paid)\b/i},
  {
    reason: 'warranty',
    re: /\b(warranty|warranties|garantie|refunds?|terugbetal\w*|remboursement|reimburs\w*|returns?|retour\w*|rma|replacement|replace|vervang\w*|remplac\w*|defect\w*|broken on arrival|dead on arrival|doa|claims?)\b/i,
  },
  {
    reason: 'internal',
    re: /\b(press|journalist|partnerships?|sponsor\w*|wholesale|resell\w*|distribut(?:or|ion)|legal|lawyer|gdpr|privacy|complaints?|klacht|plainte|quote|dealer|business|company|collab\w*)\b/i,
  },
];

export type RouteDecision = {route: Route; reason: string};

/** The first hard rule that forces the team route, or null. `texts` are every customer-written field of the ticket. */
export function hardTeamReason(ticket: Pick<Ticket, 'topic' | 'orderNumber' | 'name' | 'email'>, texts: string[]): string | null {
  if (!COMMUNITY_TOPICS.has(ticket.topic)) return 'topic';
  if (ticket.orderNumber) return 'order';
  for (const text of texts) {
    for (const r of RULES) if (r.re.test(text)) return r.reason;
    // Anything the scrubber would redact (emails, phone numbers, IBANs, cards, tokens) is personal data.
    if (redactTicketText(text, ticket) !== text) return 'personal';
    const scrubbed = scrubForPublic(text);
    if (scrubbed.blocked || scrubbed.redactionCount > 0) return 'personal';
  }
  return null;
}

/** community only with consent, the flag, a `community` label and no hard rule. Pure. */
export function decideRoute(opts: {
  ticket: Pick<Ticket, 'topic' | 'orderNumber' | 'name' | 'email' | 'communityConsent'>;
  texts: string[];
  label: Route | undefined;
  enabled: boolean;
}): RouteDecision {
  if (!opts.enabled) return {route: 'team', reason: 'disabled'};
  if (!opts.ticket.communityConsent) return {route: 'team', reason: 'no_consent'};
  const hard = hardTeamReason(opts.ticket, opts.texts);
  if (hard) return {route: 'team', reason: hard};
  if (opts.label !== 'community') return {route: 'team', reason: 'label'};
  return {route: 'community', reason: 'label'};
}

/** The forum post title: the scrubbed question in one line. */
function titleOf(ticket: Ticket, text: string): string {
  const base = ticket.product ? `${redactTicketText(ticket.product, ticket)}: ` : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return `${base}${flat}`.slice(0, 90);
}

/**
 * Apply the AI label to a ticket: when the decision is community, post the
 * anonymised first question to #help and move the ticket to that route.
 * Returns the decision; a Discord failure leaves the ticket on the team route.
 */
export async function routeTicket(deps: Deps, ticket: Ticket, label: Route | undefined): Promise<RouteDecision> {
  const customerTexts = (await deps.store.messages(ticket.ref)).filter((m) => m.role === 'customer').map((m) => m.body);
  const decision = decideRoute({
    ticket,
    texts: [ticket.subject, ticket.product ?? '', ...customerTexts].filter(Boolean),
    label,
    // Only an untouched ticket moves: no staff reply, no assignee, no post yet.
    enabled: communityEnabled(deps.env) && ticket.route === 'team' && !ticket.communityPostId && ticket.status !== 'closed' && ticket.lastStaffAt === null && ticket.assignee === null,
  });
  const now = (deps.now ?? Date.now)();
  await deps.store.audit('system', 'route_decision', ticket.ref, `${decision.route}:${decision.reason}`, now);
  if (decision.route !== 'community') return decision;

  const question = scrubForPublic(redactTicketText(customerTexts[0] ?? '', ticket)).content;
  if (!question.trim()) return {route: 'team', reason: 'empty'};
  const content = `${customerBody(question)}\n\n${COMMUNITY_POST_FOOTER}`;
  try {
    const post = await deps.discord.createForumPostIn(deps.env.DISCORD_HELP_CHANNEL_ID!, {name: escapeDiscord(titleOf(ticket, question)), content});
    await deps.store.updateTicket(ticket.ref, {route: 'community', communityPostId: post.threadId, communityCursor: post.messageId, communitySyncedAt: now, updatedAt: now});
    await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: 'sent_to_community', attachments: [], createdAt: now});
    return decision;
  } catch (err) {
    console.warn('[support] community post failed', ticket.ref, err instanceof Error ? err.message : 'error');
    return {route: 'team', reason: 'post_failed'};
  }
}

const COMMUNITY_THROTTLE_MS = 4000;

/** Copy new member replies of the forum post to the ticket, scrubbed, as `community` messages. */
export async function syncCommunity(deps: Deps, ticket: Ticket, opts: {force?: boolean} = {}): Promise<Ticket> {
  if (ticket.route !== 'community' || !ticket.communityPostId) return ticket;
  const now = (deps.now ?? Date.now)();
  if (!opts.force && ticket.communitySyncedAt && now - ticket.communitySyncedAt < COMMUNITY_THROTTLE_MS) return ticket;
  try {
    const post = await deps.discord.thread(ticket.communityPostId);
    if (!post) {
      // The post was deleted in Discord: the question goes back to the team.
      const patch = {route: 'team' as Route, communityPostId: null, communitySyncedAt: now, updatedAt: now, status: ticket.status === 'closed' ? ticket.status : ('open' as Ticket['status'])};
      await deps.store.updateTicket(ticket.ref, patch);
      await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: 'community_removed', attachments: [], createdAt: now});
      return {...ticket, ...patch};
    }
    const fresh = await deps.discord.messagesAfter(ticket.communityPostId, ticket.communityCursor, 100);
    let cursor = ticket.communityCursor;
    let added = 0;
    for (const m of fresh) {
      cursor = m.id;
      if (m.author.bot) continue;
      const scrubbed = scrubForPublic(m.content.trim());
      if (scrubbed.blocked || !scrubbed.content) continue;
      // Members stay anonymous to the asker; files are not copied.
      const inserted = await deps.store.addMessage({ref: ticket.ref, discordId: m.id, role: 'community', author: 'Community', body: scrubbed.content, attachments: [], createdAt: Date.parse(m.createdAt) || now});
      if (inserted) added++;
    }
    const patch = {communityCursor: cursor, communitySyncedAt: now, ...(added ? {lastCommunityAt: now, updatedAt: now} : {})};
    await deps.store.updateTicket(ticket.ref, patch);
    return {...ticket, ...patch};
  } catch (err) {
    console.warn('[support] community sync failed', ticket.ref, err instanceof Error ? err.message : 'error');
    return ticket;
  }
}

/** The team takes a community ticket back: team route, assigned, the forum told. */
export async function takeOver(deps: Deps, ticket: Ticket, login: string): Promise<Ticket> {
  const now = (deps.now ?? Date.now)();
  const patch = {route: 'team' as Route, assignee: login, updatedAt: now};
  await deps.store.updateTicket(ticket.ref, patch);
  await deps.store.addMessage({ref: ticket.ref, discordId: null, role: 'system', author: '', body: 'taken_over_by_team', attachments: [], createdAt: now});
  if (ticket.communityPostId) {
    try {
      await deps.discord.post(ticket.communityPostId, COMMUNITY_TAKEOVER_NOTE);
    } catch (err) {
      console.warn('[support] takeover note not posted', ticket.ref, err instanceof Error ? err.message : 'error');
    }
  }
  return {...ticket, ...patch};
}
