/**
 * Customer mail, pure rules (no network, no storage): who a message is from,
 * whether it is a customer at all, the reply text without quotes and
 * signatures, a topic guess, an order number, a ticket reference.
 * mail.ts runs these over what mail-gmail.ts fetched.
 */
import {parseTicketRef} from './tokens.ts';
import {normalizeOrderNumber} from './shopify.ts';
import type {TicketTopic} from './form.ts';

/** A fetched message reduced to what the rules need. Header names are lowercase. */
export type MailMessage = {
  id: string;
  threadId: string;
  labelIds: string[];
  headers: Record<string, string[]>;
  text: string | null;
  html: string | null;
  attachmentCount: number;
  /** Epoch milliseconds, Gmail's receive time. */
  receivedAt: number;
};

export type MailConfig = {
  /** The customer addresses a mail must have been sent to. */
  addresses: string[];
  /** Domains whose mail is never a customer (own domains). */
  ownDomains: string[];
  /** Senders (address, @domain or domain) taken even when a heuristic would drop them. */
  allow: string[];
  /** Senders (address, @domain or domain) always dropped: suppliers, newsletters, noisy tools. */
  deny: string[];
};

export const DEFAULT_OWN_DOMAINS = ['opendrone.be', 'incutec.eu'];

export function headerOf(m: MailMessage, name: string): string {
  return (m.headers[name.toLowerCase()] ?? [])[0]?.trim() ?? '';
}

export function listConfig(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// --------------------------------------------------------------------------
// Addresses
// --------------------------------------------------------------------------

const ADDRESS_RE = /<([^<>\s]+@[^<>\s]+)>|([^\s<>"',;()]+@[^\s<>"',;()]+)/;

export type Address = {email: string; name: string};

/** The first address of a From-like header: `Jan Peeters <jan@x.be>`, `"Peeters, Jan" <...>`, `jan@x.be`. */
export function parseAddress(header: string | undefined): Address | null {
  if (!header) return null;
  const m = header.match(ADDRESS_RE);
  if (!m) return null;
  const email = (m[1] ?? m[2] ?? '').toLowerCase().replace(/^mailto:/, '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) return null;
  const name = header
    .slice(0, m.index)
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .replace(/\\(.)/g, '$1');
  return {email, name};
}

/** Every address in a header, lowercase. */
export function allAddresses(header: string | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  const re = new RegExp(ADDRESS_RE.source, 'g');
  for (const m of header.matchAll(re)) out.push((m[1] ?? m[2] ?? '').toLowerCase());
  return out;
}

export const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** `entry` is `a@b.c`, `@b.c` or `b.c` (the domain and its subdomains). */
export function matchesEntry(email: string, entry: string): boolean {
  const domain = domainOf(email);
  if (entry.includes('@') && !entry.startsWith('@')) return email === entry;
  const d = entry.replace(/^@/, '');
  return domain === d || domain.endsWith(`.${d}`);
}

const matchesAny = (email: string, entries: string[]) => entries.some((e) => matchesEntry(email, e));

// --------------------------------------------------------------------------
// Who wrote, and is it a customer
// --------------------------------------------------------------------------

/**
 * The customer. A mail relayed by a Google group arrives From the group
 * ("Jan via Support"); the person is then in X-Original-Sender. A mail
 * from a own domain without that header is staff or our own mail.
 */
export function senderOf(m: MailMessage, cfg: MailConfig): Address | null {
  const from = parseAddress(headerOf(m, 'from'));
  if (from && matchesAny(from.email, cfg.ownDomains)) {
    const original = parseAddress(headerOf(m, 'x-original-sender')) ?? null;
    if (original && !matchesAny(original.email, cfg.ownDomains)) {
      return {email: original.email, name: from.name.replace(/\s+via\s+.*$/i, '').trim()};
    }
  }
  return from;
}

/** Was the mail addressed to one of the customer addresses (To, Cc, or the delivery headers)? */
export function addressedTo(m: MailMessage, cfg: MailConfig): boolean {
  const seen = ['to', 'cc', 'delivered-to', 'x-original-to', 'x-forwarded-to', 'x-forwarded-for', 'envelope-to']
    .flatMap((h) => m.headers[h] ?? [])
    .flatMap((v) => allAddresses(v));
  return seen.some((a) => cfg.addresses.includes(a));
}

const ROBOT_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|alerts?|auto(mated)?|system|robot|news(letter)?|marketing|mailer|daemon)([-_.+].*)?$/i;

/**
 * The authentication result Gmail recorded when it received the mail:
 * DMARC pass, or (without a DMARC result) DKIM or SPF pass. A mail that
 * fails this is not trusted to name its sender.
 */
export function authenticated(m: MailMessage): boolean {
  const results = [...(m.headers['authentication-results'] ?? []), ...(m.headers['arc-authentication-results'] ?? [])].join(' ').toLowerCase();
  if (/\bdmarc=pass\b/.test(results)) return true;
  if (/\bdmarc=(fail|softfail|temperror|permerror)\b/.test(results)) return false;
  return /\b(dkim|spf)=pass\b/.test(results);
}

export type Verdict = {ok: true; sender: Address} | {ok: false; reason: string};

/**
 * Customer or not. Reasons are stable strings: they are counted in the job
 * report and stored on the ignored row. The deny list and own domains win
 * over everything; the allow list lifts only the automation heuristics.
 */
export function classify(m: MailMessage, cfg: MailConfig): Verdict {
  if (m.labelIds.some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT' || l === 'SENT')) return {ok: false, reason: 'label'};
  const sender = senderOf(m, cfg);
  if (!sender) return {ok: false, reason: 'no_sender'};
  if (matchesAny(sender.email, cfg.ownDomains)) return {ok: false, reason: 'own_domain'};
  if (matchesAny(sender.email, cfg.deny)) return {ok: false, reason: 'denied'};
  if (!addressedTo(m, cfg)) return {ok: false, reason: 'not_addressed'};
  if (!authenticated(m)) return {ok: false, reason: 'unauthenticated'};
  if (matchesAny(sender.email, cfg.allow)) return {ok: true, sender};

  const local = sender.email.slice(0, sender.email.indexOf('@'));
  if (ROBOT_LOCAL.test(local)) return {ok: false, reason: 'no_reply_sender'};
  const auto = headerOf(m, 'auto-submitted').toLowerCase();
  if (auto && auto !== 'no') return {ok: false, reason: 'auto_submitted'};
  if (/\b(bulk|list|junk|auto_reply)\b/i.test(headerOf(m, 'precedence'))) return {ok: false, reason: 'bulk'};
  if (m.headers['x-autoreply'] || m.headers['x-autorespond'] || m.headers['x-auto-response-suppress']) return {ok: false, reason: 'auto_reply'};
  if (m.headers['list-id'] || m.headers['list-unsubscribe']) return {ok: false, reason: 'newsletter'};
  if (/multipart\/report|delivery-status/i.test(headerOf(m, 'content-type'))) return {ok: false, reason: 'bounce'};
  if (/^<\s*>$/.test(headerOf(m, 'return-path'))) return {ok: false, reason: 'bounce'};
  if (m.labelIds.some((l) => l === 'CATEGORY_PROMOTIONS' || l === 'CATEGORY_SOCIAL' || l === 'CATEGORY_FORUMS')) {
    return {ok: false, reason: 'category'};
  }
  const subject = headerOf(m, 'subject');
  if (/^(automatic reply|auto(matic)?[-\s]?reply|out of office|afwezig|abwesen|absence du bureau|undeliverable|delivery status notification|mail delivery failed|returned mail)/i.test(subject)) {
    return {ok: false, reason: 'auto_reply'};
  }
  return {ok: true, sender};
}

// --------------------------------------------------------------------------
// Text
// --------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

/** Readable text from an HTML-only mail: quoted replies dropped, tags stripped, basic entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
    .replace(/<div class="gmail_quote"[\s\S]*$/i, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    });
}

const ATTRIBUTION = [
  /^on .{5,300}wrote:?\s*$/i,
  /^(le|el|am|op|il|em) .{5,300}(a écrit|escribió|schrieb|schreef|ha scritto|escreveu)\b[^\n]{0,160}$/i,
];
const CUT_LINE = [
  /^-{2,}\s*(original message|forwarded message|oorspronkelijk bericht|doorgestuurd bericht|message d'origine|message transféré|ursprüngliche nachricht|weitergeleitete nachricht)/i,
  /^_{8,}\s*$/,
  /^-- ?$/,
  /^(sent from my|sent from outlook|get outlook for|verzonden vanaf|verstuurd vanaf|envoyé de mon|envoyé depuis|gesendet von meinem)\b/i,
];
const HEADER_BLOCK = /^(from|von|de|van):\s.+/i;
const HEADER_FOLLOW = /^(sent|date|gesendet|envoyé|verzonden|datum):\s/i;

/**
 * The part the customer wrote now: quoted lines (`>`) are removed, and the
 * text is cut at the first attribution line ("On ... wrote:"), forwarded or
 * original-message marker, Outlook header block, signature delimiter or
 * mobile footer. Falls back to the unstripped text when nothing is left.
 */
export function stripQuoted(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (CUT_LINE.some((re) => re.test(trimmed))) break;
    if (ATTRIBUTION.some((re) => re.test(trimmed))) break;
    // The attribution wraps onto a second line in many clients.
    const joined = `${trimmed} ${lines[i + 1]?.trim() ?? ''}`.trim();
    if (/^(on|le|el|am|op) /i.test(trimmed) && joined.length < 320 && ATTRIBUTION.some((re) => re.test(joined))) break;
    if (HEADER_BLOCK.test(trimmed) && lines.slice(i + 1, i + 5).some((l) => HEADER_FOLLOW.test(l.trim()))) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out) return out;
  return raw
    .split('\n')
    .map((l) => l.replace(/^\s*>+\s?/, ''))
    .join('\n')
    .trim()
    .slice(0, 1000);
}

/** The new text of a mail: plain part preferred, HTML as the fallback. */
export function bodyText(m: MailMessage): string {
  const source = m.text && m.text.trim() ? m.text : m.html ? htmlToText(m.html) : '';
  return stripQuoted(source).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Subject without Re:/Fwd: prefixes, one line, at most 120 characters. */
export function cleanSubject(subject: string): string {
  const s = subject
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/^(\s*(re|fw|fwd|aw|wg|tr|antw|doorgestuurd)\s*:\s*)+/i, '')
    .trim();
  return s.length > 120 ? `${s.slice(0, 119).trimEnd()}…` : s;
}

// --------------------------------------------------------------------------
// Ticket hints
// --------------------------------------------------------------------------

const REF_IN_TEXT = /\bOD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/i;

/** A ticket reference written in the subject (our reply notice carries one). */
export function refInSubject(subject: string): string | null {
  const m = subject.match(REF_IN_TEXT);
  return m ? parseTicketRef(m[0]) : null;
}

const ORDER_PATTERNS = [/#\s?(\d{4,10})\b/, /\b(?:order|bestelling|commande|bestellung|preorder|pre-order)\s*(?:number|nr\.?|no\.?|numero|nummer|n°)?\s*:?\s*#?\s*(\d{4,10})\b/i];

/** An order number the customer wrote (`#1042`, "order 1042"), as Shopify names it, or null. */
export function orderNumberIn(...texts: string[]): string | null {
  for (const t of texts) {
    for (const re of ORDER_PATTERNS) {
      const m = t.match(re);
      if (m) return normalizeOrderNumber(m[1]);
    }
  }
  return null;
}

const TOPIC_WORDS: Array<[TicketTopic, RegExp]> = [
  ['warranty', /\b(warranty|garantie|garantía|rma|return(ed)?|retour|refund|terugbetal|remboursement|defect|defective|broken|kapot|cassé|dead on arrival|doa|replacement)\b/i],
  ['product', /\b(firmware|flash(ing)?|betaflight|inav|ardupilot|bootloader|dfu|esc|am32|motor|flight controller|openfc|gps|vtx|elrs|crsf|sbus|usb|uart|pinout|schematic|config(uration)?|bind(ing)?|calibrat\w*)\b/i],
  ['order', /\b(order|preorder|pre-order|bestelling|commande|shipping|shipment|ship date|delivery|tracking|invoice|factuur|facture|payment|betaling|paid|address|adres|cancel|annul)\b/i],
];

/** Warranty beats product beats order when several match: a broken part from an order is a warranty case, and a firmware question that names an order is a product question. */
export function guessTopic(subject: string, body: string): TicketTopic {
  const text = `${subject}\n${body}`.slice(0, 3000);
  for (const [topic, re] of TOPIC_WORDS) if (re.test(text)) return topic;
  return 'other';
}

/** A display name for the ticket: the header name, else the address' local part. */
export function displayName(sender: Address): string {
  const fromName = sender.name.replace(/[<>@]/g, '').replace(/\s+/g, ' ').trim();
  if (fromName) return fromName.slice(0, 80);
  const local = sender.email.slice(0, sender.email.indexOf('@')).replace(/[._+-]+/g, ' ').trim();
  return (local || 'Customer').slice(0, 80);
}
