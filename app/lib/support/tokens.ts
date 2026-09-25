/**
 * Ticket references, resume links and the ticket cookie.
 *
 * - A ticket reference (`OD-K7M4-Q2XF`) is random, 40 bits, and not a
 *   secret on its own: it is what customer and staff quote.
 * - A resume link carries an HMAC-signed token for one ticket: reference,
 *   the ticket's link version and an expiry. "Reset link" bumps the
 *   version, which kills every older link and cookie entry for it.
 * - The `od_support` cookie is a signed list of the tickets this browser
 *   may open, written when a ticket is created, a resume link is opened or
 *   a lookup succeeds. HttpOnly, SameSite=Lax (a resume link opened from
 *   another app must be able to set it).
 *
 * Token and cookie use different audiences, so neither replays as the
 * other. Keyed with SUPPORT_SESSION_SECRET, falling back to SESSION_SECRET.
 */

const enc = new TextEncoder();
const RESUME_AUD = 'support-resume-v2';
const COOKIE_AUD = 'support-cookie-v2';
export const RESUME_TTL_SECONDS = 60 * 60 * 24 * 90;
export const SUPPORT_COOKIE = 'od_support';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 180;
const COOKIE_MAX_TICKETS = 12;

type Env = {SUPPORT_SESSION_SECRET?: string; SESSION_SECRET?: string};

function secret(env: Env): string {
  const s = env.SUPPORT_SESSION_SECRET || env.SESSION_SECRET;
  if (!s) throw new Error('SUPPORT_SESSION_SECRET or SESSION_SECRET required');
  return s;
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function unb64url(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sign(env: Env, aud: string, payload: object): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({...payload, aud})));
  return `${body}.${await hmac(secret(env), body)}`;
}

async function verify<T>(env: Env, aud: string, token: string | null | undefined): Promise<T | null> {
  if (!token || token.length > 4096) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  let expected: string;
  try {
    expected = await hmac(secret(env), body);
  } catch {
    return null;
  }
  if (!constantTimeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(body))) as T & {aud?: string};
    if (payload.aud !== aud) return null;
    return payload;
  } catch {
    return null;
  }
}

// Crockford base32 without I, L, O, U: readable aloud, no 0/O mix-ups.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newTicketRef(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b & 31];
  return `OD-${s.slice(0, 4)}-${s.slice(4)}`;
}

const REF_RE = /^OD-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/** Normalise what a person typed ("od k7m4q2xf", "OD-K7M4-Q2XF") or null. */
export function parseTicketRef(input: string | null | undefined): string | null {
  if (!input) return null;
  const compact = input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^OD/, '');
  if (compact.length !== 8) return null;
  const ref = `OD-${compact.slice(0, 4)}-${compact.slice(4)}`;
  return REF_RE.test(ref) ? ref : null;
}

export type ResumePayload = {v: 2; r: string; k: number; exp: number};

export async function signResumeToken(
  env: Env,
  ref: string,
  version: number,
  now = Date.now(),
  ttlSeconds = RESUME_TTL_SECONDS,
): Promise<string> {
  const payload: ResumePayload = {v: 2, r: ref, k: version, exp: Math.floor(now / 1000) + ttlSeconds};
  return sign(env, RESUME_AUD, payload);
}

/** The token's reference and version, or null if forged, malformed or expired. */
export async function verifyResumeToken(
  env: Env,
  token: string | null | undefined,
  now = Date.now(),
): Promise<{ref: string; version: number} | null> {
  const p = await verify<ResumePayload>(env, RESUME_AUD, token);
  if (!p || p.v !== 2 || !parseTicketRef(p.r) || typeof p.k !== 'number') return null;
  if (typeof p.exp !== 'number' || p.exp < Math.floor(now / 1000)) return null;
  return {ref: p.r, version: p.k};
}

export function resumeUrl(origin: string, token: string): string {
  const url = new URL('/support/resume', origin);
  url.searchParams.set('t', token);
  return url.toString();
}

export type CookieTicket = {r: string; k: number};

export async function readTicketCookie(env: Env, request: Request): Promise<CookieTicket[]> {
  const header = request.headers.get('Cookie') ?? '';
  let raw: string | null = null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.split('=');
    if (name?.trim() === SUPPORT_COOKIE) raw = rest.join('=').trim() || null;
  }
  const payload = await verify<{v: 2; t: CookieTicket[]}>(env, COOKIE_AUD, raw);
  if (!payload || payload.v !== 2 || !Array.isArray(payload.t)) return [];
  return payload.t
    .filter((t) => parseTicketRef(t?.r) && typeof t.k === 'number')
    .slice(0, COOKIE_MAX_TICKETS);
}

/** Set-Cookie value holding `tickets`, newest first, deduplicated and capped. */
export async function ticketCookie(env: Env, tickets: CookieTicket[], secure = true): Promise<string> {
  const seen = new Set<string>();
  const list = tickets.filter((t) => !seen.has(t.r) && seen.add(t.r)).slice(0, COOKIE_MAX_TICKETS);
  const value = await sign(env, COOKIE_AUD, {v: 2, t: list});
  return [
    `${SUPPORT_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ].join('; ');
}

/** Add or refresh one ticket at the front of the cookie list. */
export async function withTicket(env: Env, current: CookieTicket[], ticket: CookieTicket, secure = true): Promise<string> {
  return ticketCookie(env, [ticket, ...current.filter((t) => t.r !== ticket.r)], secure);
}
