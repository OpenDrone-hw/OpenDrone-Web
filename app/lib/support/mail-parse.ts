/**
 * Customer mail, pure rules (no network, no storage): who a message is from,
 * whether it is a customer at all, the reply text without quotes and
 * signatures, a topic guess, an order number, a ticket reference.
 * mail.ts runs these over what mail-gmail.ts fetched.
 */
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

/** The sender: the From header. A Google group here does not rewrite From, so there is no other source. */
export function senderOf(m: MailMessage): Address | null {
  return parseAddress(headerOf(m, 'from'));
}

/** Was the mail addressed to one of the customer addresses (To, Cc, or the delivery headers)? */
export function addressedTo(m: MailMessage, cfg: MailConfig): boolean {
  const seen = ['to', 'cc', 'delivered-to', 'x-original-to', 'x-forwarded-to', 'envelope-to']
    .flatMap((h) => m.headers[h] ?? [])
    .flatMap((v) => allAddresses(v));
  return seen.some((a) => cfg.addresses.includes(a));
}

const ROBOT_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|alerts?|auto(mated)?|system|robot|news(letter)?|marketing|mailer|daemon)([-_.+].*)?$/i;

const TRUSTED_AUTHSERV = 'mx.google.com';

/** Is `a` the same organisation as `b` (relaxed alignment: equal, or one a subdomain of the other)? */
function aligned(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^.*@/, '').replace(/[>\s;]/g, '');
  const y = b.toLowerCase();
  return Boolean(x) && (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`));
}

/** The text with every parenthesised comment removed, nesting respected. */
function stripComments(text: string): string {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

export type AuthResult = {
  /** pass: authenticated as the From domain. fail: a DMARC fail. none: no usable result. */
  status: 'pass' | 'fail' | 'none';
  /** DMARC failed and the sender's domain publishes p=reject or p=quarantine: a spoof. */
  spoof: boolean;
};

/**
 * What Gmail concluded about the From domain.
 *
 * Only the topmost Authentication-Results header counts, and only when its
 * authserv-id is mx.google.com: Gmail prepends its own result on receipt, so
 * a header the sender planted sits below it. Before matching, every
 * parenthesised comment is removed and every `arc=` entry dropped: an ARC
 * chain the sender sealed can carry `dmarc=pass` text in its comment.
 * Then a DMARC fail wins; a DMARC pass counts only with `header.from`
 * aligned with the From domain; without a DMARC entry (Gmail omits it for a
 * domain without DMARC) a DKIM pass whose `header.d`/`header.i`, or an SPF
 * pass whose `smtp.mailfrom`, is aligned with the From domain counts.
 */
export function authResult(m: MailMessage, fromDomain: string): AuthResult {
  const none: AuthResult = {status: 'none', spoof: false};
  const raw = (m.headers['authentication-results'] ?? [])[0]?.toLowerCase();
  if (!raw) return none;
  const [authserv, ...rest] = stripComments(raw).split(';');
  if (authserv!.trim().split(/\s+/)[0] !== TRUSTED_AUTHSERV) return none;
  const entries = rest.map((r) => r.trim()).filter((r) => r && !/^arc=/.test(r));
  const domain = fromDomain.toLowerCase();

  const dmarc = entries.filter((r) => /^dmarc=/.test(r));
  if (dmarc.some((r) => /^dmarc=(fail|softfail|temperror|permerror)\b/.test(r))) {
    // The policy sits in the comment: `dmarc=fail (p=REJECT sp=REJECT dis=NONE) header.from=x`.
    const policy = raw.match(/dmarc=fail\s*\(([^)]*)\)/)?.[1] ?? '';
    return {status: 'fail', spoof: /\bp=(reject|quarantine)\b/.test(policy)};
  }
  if (dmarc.some((r) => /^dmarc=pass\b/.test(r) && aligned(r.match(/header\.from=([^\s;]+)/)?.[1] ?? '', domain))) {
    return {status: 'pass', spoof: false};
  }
  for (const r of entries) {
    if (/^dkim=pass\b/.test(r) && aligned(r.match(/header\.(?:d|i)=([^\s;]+)/)?.[1] ?? '', domain)) return {status: 'pass', spoof: false};
    if (/^spf=pass\b/.test(r) && aligned(r.match(/smtp\.mailfrom=([^\s;]+)/)?.[1] ?? '', domain)) return {status: 'pass', spoof: false};
  }
  return none;
}

export const authenticated = (m: MailMessage, fromDomain: string): boolean => authResult(m, fromDomain).status === 'pass';

/**
 * Mail that Google Groups relayed from one of our group addresses
 * (support@, sales@, info@): it carries the group's own headers. Such a mail
 * is not a newsletter, and its customer-domain DMARC result is expected to fail.
 */
export function relayedByOurGroup(m: MailMessage, cfg: MailConfig): boolean {
  if (m.headers['x-google-group-id']) return true;
  const lists = [...(m.headers['mailing-list'] ?? []), ...(m.headers['list-id'] ?? [])].join(' ').toLowerCase();
  return cfg.ownDomains.some((d) => lists.includes(d));
}

/**
 * `verified` is false when the sender did not authenticate as its From
 * domain. Such a mail is still a customer, but it only ever opens a ticket
 * flagged sender-unverified (mail.ts).
 */
export type Verdict = {ok: true; sender: Address; verified: boolean} | {ok: false; reason: string};

/**
 * Customer or not. Reasons are stable strings: they are counted in the job
 * report and stored on the ignored row. The deny list and own domains win
 * over everything; the allow list lifts only the automation heuristics.
 */
export function classify(m: MailMessage, cfg: MailConfig): Verdict {
  if (m.labelIds.some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT' || l === 'SENT')) return {ok: false, reason: 'label'};
  const sender = senderOf(m);
  if (!sender) return {ok: false, reason: 'no_sender'};
  if (matchesAny(sender.email, cfg.ownDomains)) return {ok: false, reason: 'own_domain'};
  if (matchesAny(sender.email, cfg.deny)) return {ok: false, reason: 'denied'};
  if (!addressedTo(m, cfg)) return {ok: false, reason: 'not_addressed'};

  const relayed = relayedByOurGroup(m, cfg);
  const auth = authResult(m, domainOf(sender.email));
  // A DMARC fail under p=reject or p=quarantine from the sender's own domain
  // is a spoof. Mail our own group relayed is expected to fail it: it goes on.
  if (auth.spoof && !relayed) return {ok: false, reason: 'spoofed'};
  const ok: Verdict = {ok: true, sender, verified: auth.status === 'pass'};
  if (matchesAny(sender.email, cfg.allow)) return ok;

  const local = sender.email.slice(0, sender.email.indexOf('@'));
  if (ROBOT_LOCAL.test(local)) return {ok: false, reason: 'no_reply_sender'};
  const autoSubmitted = headerOf(m, 'auto-submitted').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return {ok: false, reason: 'auto_submitted'};
  if (!relayed && /\b(bulk|list|junk|auto_reply)\b/i.test(headerOf(m, 'precedence'))) return {ok: false, reason: 'bulk'};
  if (m.headers['x-autoreply'] || m.headers['x-autorespond'] || m.headers['x-auto-response-suppress']) return {ok: false, reason: 'auto_reply'};
  if (!relayed && (m.headers['list-id'] || m.headers['list-unsubscribe'])) return {ok: false, reason: 'newsletter'};
  if (/multipart\/report|delivery-status/i.test(headerOf(m, 'content-type'))) return {ok: false, reason: 'bounce'};
  if (/^<\s*>$/.test(headerOf(m, 'return-path'))) return {ok: false, reason: 'bounce'};
  if (m.labelIds.some((l) => l === 'CATEGORY_PROMOTIONS' || l === 'CATEGORY_SOCIAL' || l === 'CATEGORY_FORUMS')) {
    return {ok: false, reason: 'category'};
  }
  const subject = headerOf(m, 'subject');
  if (/^(automatic reply|auto(matic)?[-\s]?reply|out of office|afwezig|abwesen|absence du bureau|undeliverable|delivery status notification|mail delivery failed|returned mail)/i.test(subject)) {
    return {ok: false, reason: 'auto_reply'};
  }
  return ok;
}

// --------------------------------------------------------------------------
// Text
// --------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};

const MAX_HTML_CHARS = 50_000;
const SKIP_TAGS = new Set(['script', 'style', 'head']);
const BREAK_TAGS = new Set(['br', 'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * Readable text from an HTML-only mail: at most the first 50,000 characters,
 * one linear scan (no backtracking patterns), quoted replies (blockquote,
 * Gmail's quote div) dropped, tags stripped, basic entities decoded. An
 * unclosed tag ends the text.
 */
export function htmlToText(html: string): string {
  const src = html.slice(0, MAX_HTML_CHARS);
  const lower = src.toLowerCase();
  let out = '';
  let quote = 0;
  let skip: string | null = null;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      if (!quote && !skip) out += src.slice(i);
      break;
    }
    if (!quote && !skip) out += src.slice(i, lt);
    const next = src[lt + 1] ?? '';
    if (!/[a-zA-Z/!]/.test(next)) {
      if (!quote && !skip) out += '<';
      i = lt + 1;
      continue;
    }
    const gt = src.indexOf('>', lt + 1);
    if (gt < 0) break;
    const tag = lower.slice(lt + 1, gt);
    const closing = tag.startsWith('/');
    const name = tag.slice(closing ? 1 : 0).match(/^[a-z0-9]*/)![0];
    i = gt + 1;
    if (skip) {
      if (closing && name === skip) skip = null;
      continue;
    }
    if (!closing && SKIP_TAGS.has(name) && !tag.endsWith('/')) {
      skip = name;
      continue;
    }
    if (!closing && name === 'div' && tag.includes('gmail_quote')) break;
    if (name === 'blockquote') {
      quote = closing ? Math.max(0, quote - 1) : quote + 1;
      continue;
    }
    if (!quote && BREAK_TAGS.has(name) && (name === 'br' || closing)) out += '\n';
  }
  return out.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (all, e: string) => {
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
// Topic and order hints
// --------------------------------------------------------------------------

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
