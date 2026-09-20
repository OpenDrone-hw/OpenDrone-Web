/**
 * Long-lived signed tokens for one-click newsletter unsubscribe links.
 *
 * The welcome email embeds `/newsletter/unsubscribe?t=<token>`; a valid
 * token lets the route unsubscribe that exact address with a single
 * confirm click, no form, no rate-limit friction. Same HMAC recipe as
 * app/lib/growth/survey-token.ts with a separate audience string, so
 * tokens can never be replayed across schemes despite the shared
 * SESSION_SECRET.
 *
 * TTL is one year: unsubscribe links live in inboxes for a long time,
 * and an expired link only downgrades to the manual email form on the
 * same page, so expiry is a soft edge, not a failure.
 * Token format: `b64url(email).exp.b64url(hmac)`.
 */

const enc = new TextEncoder();
const UNSUB_AUD = 'newsletter-unsubscribe-v1';
const DEFAULT_TTL_SECONDS = 365 * 24 * 60 * 60;

type Env = {SESSION_SECRET?: string};

function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Uint8Array | null {
  try {
    const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
    const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmac(key: string, payload: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(payload));
  return b64urlEncode(sig);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint an unsubscribe token. Returns null when SESSION_SECRET is unset:
 * the caller omits the one-click link and the email falls back to the
 * plain form URL. Degrade-soft, never throws.
 */
export async function signUnsubscribeToken(
  env: Env,
  email: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<string | null> {
  if (!env.SESSION_SECRET) {
    console.warn('[growth/unsubscribe-token] SESSION_SECRET unset — no token');
    return null;
  }
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmac(env.SESSION_SECRET, `${UNSUB_AUD}|${email}|${exp}`);
  return `${b64urlEncode(enc.encode(email))}.${exp}.${sig}`;
}

/**
 * Verify an unsubscribe token. Returns the bound email, or null on any
 * failure (malformed, bad signature, expired, secret unset).
 */
export async function verifyUnsubscribeToken(
  env: Env,
  token: string | null | undefined,
): Promise<{email: string} | null> {
  if (!token || !env.SESSION_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [emailB64, expRaw, sig] = parts;
  const emailBytes = b64urlDecode(emailB64);
  if (!emailBytes) return null;
  const email = new TextDecoder().decode(emailBytes);
  const exp = Number(expRaw);
  if (!email || !Number.isInteger(exp)) return null;
  const expected = await hmac(
    env.SESSION_SECRET,
    `${UNSUB_AUD}|${email}|${exp}`,
  );
  if (!constantTimeEqual(expected, sig)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  return {email};
}
