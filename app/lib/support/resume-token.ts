/**
 * Signed magic-link tokens for the cross-device resume flow.
 *
 * This is intentionally a *separate* HMAC scheme from the cookie in
 * session.ts: same secret, but the payload includes an `aud` field so a
 * leaked resume URL can never be replayed as a session cookie (or vice
 * versa). The token is opaque base64url and short enough to fit in a
 * regular URL.
 *
 * Lifetime defaults to 14 days - long enough to cover a short holiday,
 * short enough that an email-archive compromise months later doesn't
 * hand out live support-thread access. The token is multi-use within
 * the TTL (the user may click it from a different device, then again
 * from a browser refresh); single-use would require a persistent
 * consumed-token set and break the stateless design. Resume endpoint
 * rate-limits per-IP to blunt bulk replay if a link does leak.
 */

const enc = new TextEncoder();
const RESUME_AUD = 'support-resume-v1';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export type ResumeTokenPayload = {
  v: 1;
  aud: typeof RESUME_AUD;
  tid: string; // Discord thread id
  uid: string; // ticket session id (same as cookie's `uid` so audit trails line up)
  email: string;
  name: string;
  iat: number; // unix seconds
  exp: number; // unix seconds
  pid?: string; // 10-digit public ticket ref; optional for tokens minted before this field existed
};

type Env = {SUPPORT_SESSION_SECRET?: string; SESSION_SECRET?: string};

function secret(env: Env): string {
  const s = env.SUPPORT_SESSION_SECRET || env.SESSION_SECRET;
  if (!s) throw new Error('SUPPORT_SESSION_SECRET or SESSION_SECRET required');
  return s;
}

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
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return b64urlEncode(sig);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signResumeToken(
  env: Env,
  input: {
    tid: string;
    uid: string;
    email: string;
    name: string;
    pid?: string;
    ttlSeconds?: number;
  },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: ResumeTokenPayload = {
    v: 1,
    aud: RESUME_AUD,
    tid: input.tid,
    uid: input.uid,
    email: input.email,
    name: input.name.slice(0, 80),
    iat: now,
    exp: now + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    ...(input.pid ? {pid: input.pid} : {}),
  };
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(secret(env), body);
  return `${body}.${sig}`;
}

export async function verifyResumeToken(
  env: Env,
  token: string | null | undefined,
): Promise<ResumeTokenPayload | null> {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  let expected: string;
  try {
    expected = await hmac(secret(env), body);
  } catch {
    return null;
  }
  if (!constantTimeEqual(expected, sig)) return null;
  try {
    const json = new TextDecoder().decode(b64urlDecode(body));
    const payload = JSON.parse(json) as ResumeTokenPayload;
    if (payload.v !== 1 || payload.aud !== RESUME_AUD) return null;
    if (!payload.tid || !payload.email || !payload.uid) return null;
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function buildResumeUrl(baseUrl: string, token: string): string {
  const url = new URL('/support/resume', baseUrl);
  url.searchParams.set('t', token);
  return url.toString();
}
