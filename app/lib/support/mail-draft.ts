/**
 * The Gmail draft for a customer mail (README "Mail"): a plain text UTF-8
 * reply in the customer's Gmail thread, built as an RFC 2822 message and
 * encoded base64url for `users.drafts.create`. A person edits and sends it
 * from Gmail; nothing here sends anything.
 */
import {headerOf, parseAddress, type MailMessage} from './mail-parse.ts';

export const UNVERIFIED_LINE = '[CHECK BEFORE SENDING: sender not authenticated by the mail system. Delete this line.]';
export const MAX_QUOTE_CHARS = 4000;
/** Header caps: every header line stays far below the 998 character RFC 5322 limit. */
const MAX_SUBJECT_CHARS = 200;
const MAX_NAME_CHARS = 80;
const MAX_REFERENCES = 10;

const NL = '\r\n';

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** base64url without padding, as the Gmail API wants `raw`. */
export function base64url(text: string): string {
  return toBase64(new TextEncoder().encode(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One header value on one line: no CR, LF or other control characters. */
const oneLine = (v: string): string =>
  Array.from(v, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

const isAscii = (v: string): boolean => /^[\x20-\x7e]*$/.test(v);

/**
 * RFC 2047 encoded words (UTF-8, base64), each under 75 characters, never
 * splitting a code point, joined by folding whitespace. ASCII passes through.
 */
export function encodeWords(value: string): string {
  const v = oneLine(value);
  if (isAscii(v)) return v;
  const enc = new TextEncoder();
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  const flush = () => {
    if (chunk) words.push(`=?UTF-8?B?${toBase64(enc.encode(chunk))}?=`);
    chunk = '';
    bytes = 0;
  };
  for (const ch of v) {
    const n = enc.encode(ch).length;
    // 42 bytes -> 56 base64 characters + 12 of framing = 68 < 75.
    if (bytes + n > 42) flush();
    chunk += ch;
    bytes += n;
  }
  flush();
  return words.join(`${NL} `);
}

/** "Re: " plus the subject, once. */
export function replySubject(subject: string): string {
  const s = Array.from(oneLine(subject)).slice(0, MAX_SUBJECT_CHARS).join('').trim();
  if (!s) return 'Re:';
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * One plain address: printable, no space, quote, bracket, comma, semicolon,
 * colon or backslash, so a header the sender wrote can never add a second
 * recipient or a group (`<x,y@evil>`, `<g:y@evil;>`) to the To line.
 */
const SAFE_ADDRESS = /^[^\s@<>()[\]\\,;:"\x00-\x1f\x7f]{1,64}@[^\s@<>()[\]\\,;:"\x00-\x1f\x7f]+\.[^\s@<>()[\]\\,;:"\x00-\x1f\x7f]+$/;

/** `Name <address>`, the name quoted or encoded; the bare address without a name. Null for an unsafe address. */
function mailbox(header: string): string | null {
  const a = parseAddress(header);
  if (!a || !SAFE_ADDRESS.test(a.email)) return null;
  const name = Array.from(oneLine(a.name.replace(/[<>"\\]/g, ''))).slice(0, MAX_NAME_CHARS).join('').trim();
  if (!name) return a.email;
  return isAscii(name) ? `"${name}" <${a.email}>` : `${encodeWords(name)} <${a.email}>`;
}

/** The `<id>` tokens of a Message-ID or References header; anything else in the header is dropped. */
const ids = (v: string): string[] => oneLine(v).match(/<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>/g) ?? [];

/** "> " in front of every line, at most `max` characters of the original. */
export function quoteOriginal(text: string, max = MAX_QUOTE_CHARS): string {
  const clean = text.replace(/\r\n?/g, '\n').trim();
  const cut = clean.length > max ? `${clean.slice(0, max).trimEnd()}\n[...]` : clean;
  return cut
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

export type DraftInput = {
  /** The customer's mail. */
  mail: MailMessage;
  /** The text ChatFPV drafted. */
  reply: string;
  /** The new text of the customer's mail, for the quote. */
  original: string;
  verified: boolean;
};

/** The reply body: a flag line when the sender is not authenticated, the draft, the quoted original. */
export function draftBody({mail, reply, original, verified}: DraftInput): string {
  const from = oneLine(headerOf(mail, 'from')) || 'the sender';
  const date = oneLine(headerOf(mail, 'date')) || (mail.receivedAt ? new Date(mail.receivedAt).toUTCString() : 'an earlier date');
  return [
    ...(verified ? [] : [UNVERIFIED_LINE, '']),
    reply.replace(/\r\n?/g, '\n').trim(),
    '',
    `On ${date}, ${from} wrote:`,
    quoteOriginal(original || '(no text)'),
  ].join('\n');
}

/** The RFC 2822 message of the reply draft. Null when the mail has no usable sender address. */
export function draftMessage(input: DraftInput): string | null {
  const m = input.mail;
  const to = mailbox(headerOf(m, 'from'));
  if (!to) return null;
  const messageId = ids(headerOf(m, 'message-id'))[0] ?? '';
  // The first reference (the thread root) and the most recent ones, then the mail itself, one per folded line.
  const refs = ids(headerOf(m, 'references')).filter((r) => r !== messageId);
  const references = refs.length > MAX_REFERENCES ? [refs[0]!, ...refs.slice(-(MAX_REFERENCES - 1))] : refs;
  const body = draftBody(input).replace(/\n/g, NL);
  const wrapped = (toBase64(new TextEncoder().encode(body)).match(/.{1,76}/g) ?? ['']).join(NL);
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeWords(replySubject(headerOf(m, 'subject')))}`,
    ...(messageId ? [`In-Reply-To: ${messageId}`, `References: ${[...references, messageId].join(`${NL} `)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return `${headers.join(NL)}${NL}${NL}${wrapped}${NL}`;
}

/** The `raw` field for the Gmail API. */
export function draftRaw(input: DraftInput): string | null {
  const msg = draftMessage(input);
  return msg === null ? null : base64url(msg);
}
