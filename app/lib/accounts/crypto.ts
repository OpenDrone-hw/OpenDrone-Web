/**
 * Small WebCrypto helpers for the account routes (Workers and Node share the
 * same `crypto.subtle`). Server only.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('bad base64url');
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export const b64urlText = (text: string) => b64url(enc.encode(text));
export const textFromB64url = (text: string) => dec.decode(fromB64url(text));

/** `n` random bytes, base64url (32 bytes: 43 characters). */
export function randomToken(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
}

export async function hmac(secret: string, data: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
}

export const hmacHex = async (secret: string, data: string) => hex(await hmac(secret, data));
export const hmacB64url = async (secret: string, data: string) => b64url(await hmac(secret, data));

/** Constant-time string comparison (length leaks, content does not). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** RFC 7636 S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
}

/** A PKCE challenge or verifier-sized value: 43 to 128 unreserved characters. */
export const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * Pairwise subject for chatfpv.com (accounts contract): `acct_` + first 32
 * hex of HMAC-SHA256(ACCOUNT_PAIRWISE_SALT, "chatfpv.com|" + GID).
 */
export async function pairwiseSub(salt: string, gid: string): Promise<string> {
  return `acct_${(await hmacHex(salt, `chatfpv.com|${gid}`)).slice(0, 32)}`;
}

/** SESSION_ENC_KEY (any string, 32 random bytes recommended) as an AES-256-GCM key. */
async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']);
}

/** `v1.<iv>.<ciphertext>` (base64url). */
export async function seal(secret: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await aesKey(secret), enc.encode(plaintext));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function unseal(secret: string, sealed: string): Promise<string | null> {
  const m = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(sealed);
  if (!m) return null;
  try {
    const pt = await crypto.subtle.decrypt({name: 'AES-GCM', iv: fromB64url(m[1])}, await aesKey(secret), fromB64url(m[2]));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** A signed, expiring JSON blob: `<b64url json>.<b64url hmac>`. */
export async function signBlob(secret: string, label: string, value: Record<string, unknown>): Promise<string> {
  const body = b64urlText(JSON.stringify(value));
  return `${body}.${await hmacB64url(secret, `${label}.${body}`)}`;
}

export async function openBlob<T extends {exp: number}>(secret: string, label: string, token: string, nowSec: number): Promise<T | null> {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m) return null;
  if (!safeEqual(await hmacB64url(secret, `${label}.${m[1]}`), m[2])) return null;
  try {
    const value = JSON.parse(textFromB64url(m[1])) as T;
    return typeof value?.exp === 'number' && value.exp > nowSec ? value : null;
  } catch {
    return null;
  }
}
