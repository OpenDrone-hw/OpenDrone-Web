/**
 * Signed-cookie ticket session. All ticket state (Discord thread ID, user
 * identity, last seen message cursor) lives in one HttpOnly cookie so the
 * Worker stays stateless - no KV or DO required for the MVP.
 *
 * Signature uses HMAC-SHA256 over the JSON payload, keyed with
 * SUPPORT_SESSION_SECRET. The cookie can be decoded client-side (it's
 * base64 JSON) but can't be tampered without the secret.
 */

export const SUPPORT_COOKIE = 'od_support';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type SupportTicket = {
  v: 1;
  tid: string; // Discord thread id
  uid: string; // random ticket id for abuse tracking / logs
  name: string;
  email: string;
  createdAt: number; // unix seconds
  lastCursor?: string; // Discord message id of last seen staff reply
  // 10-digit public-facing ticket reference. Optional because cookies
  // minted before this field existed don't carry one - widget falls
  // back to no display in that case.
  pid?: string;
};

type Env = {SUPPORT_SESSION_SECRET?: string; SESSION_SECRET?: string};

function secret(env: Env): string {
  const s = env.SUPPORT_SESSION_SECRET || env.SESSION_SECRET;
  if (!s) throw new Error('SUPPORT_SESSION_SECRET or SESSION_SECRET required');
  return s;
}

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign', 'verify'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return b64urlEncode(sig);
}

export async function signTicket(env: Env, ticket: SupportTicket): Promise<string> {
  const payload = b64urlEncode(enc.encode(JSON.stringify(ticket)));
  const sig = await hmac(secret(env), payload);
  return `${payload}.${sig}`;
}

export async function verifyTicket(
  env: Env,
  cookie: string | undefined | null,
): Promise<SupportTicket | null> {
  if (!cookie) return null;
  const [payload, sig] = cookie.split('.');
  if (!payload || !sig) return null;
  const expected = await hmac(secret(env), payload);
  if (!constantTimeEqual(expected, sig)) return null;
  try {
    const json = new TextDecoder().decode(b64urlDecode(payload));
    const t = JSON.parse(json) as SupportTicket;
    if (t.v !== 1 || !t.tid || !t.uid) return null;
    return t;
  } catch {
    return null;
  }
}

// Length-leaking but content-constant comparison. Exported so other
// auth gates (e.g. the cleanup endpoint's bearer token) reuse one
// vetted implementation instead of a short-circuiting `===`.
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function readSupportCookie(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.split('=');
    if (rawName?.trim() === SUPPORT_COOKIE) {
      return rest.join('=').trim() || null;
    }
  }
  return null;
}

export function buildSupportSetCookie(value: string, opts: {clear?: boolean} = {}): string {
  // SameSite=Strict: the support cookie is never needed on cross-site
  // navigation. The resume flow carries its token in the URL path, not the
  // cookie, so Strict doesn't break the email-click entry point. Strict
  // eliminates the one-click CSRF surface that Lax still allows via
  // top-level POST/form navigation.
  const parts = [
    `${SUPPORT_COOKIE}=${opts.clear ? '' : value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${opts.clear ? 0 : COOKIE_MAX_AGE}`,
  ];
  return parts.join('; ');
}

export function randomId(bytes = 12): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return b64urlEncode(arr);
}

// Public 10-digit ticket reference. Six digits are seconds-of-cycle
// (the unix-second clock modulo 10^6, rolls every ~11.6 days), four
// are CSPRNG random. Two tickets opened in the same second collide
// 1-in-10000; with low support volume that's effectively never.
//
// We deliberately don't dedupe against an external set - that would
// need KV/D1 and the value-add is theoretical at this volume. If you
// see a collision in the wild, swap this for a KV-backed counter.
export function randomTicketId(): string {
  const seconds = Math.floor(Date.now() / 1000) % 1_000_000;
  const arr = new Uint8Array(2);
  crypto.getRandomValues(arr);
  const rand = ((arr[0] << 8) | arr[1]) % 10_000;
  return (
    String(seconds).padStart(6, '0') + String(rand).padStart(4, '0')
  );
}
