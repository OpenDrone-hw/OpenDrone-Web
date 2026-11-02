/**
 * HTTP basic auth of the staging Worker (server.ts stagingGate): user
 * `opendrone`, password STAGING_PASSWORD (a secret or .dev.vars, never
 * committed). One implementation, so the site gate and the staging firmware
 * route (app/lib/flasher/staging-serve.ts) check exactly the same thing.
 */

export const STAGING_AUTH_USER = 'opendrone';

const enc = new TextEncoder();

/** Constant-time over the longer input; the length difference is folded into the result (no early exit). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * True when `header` is `Basic base64(opendrone:<password>)`. The credentials split at the FIRST ':' only
 * (a password may contain ':'); user and password are compared as UTF-8 bytes in constant time.
 * Empty password, missing header and malformed input are false.
 */
export function stagingCredentialsOk(header: string | null, password: string): boolean {
  if (!password || !header?.startsWith('Basic ')) return false;
  try {
    const raw = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    const colon = raw.indexOf(0x3a);
    if (colon < 0) return false;
    const userOk = bytesEqual(raw.subarray(0, colon), enc.encode(STAGING_AUTH_USER));
    const passOk = bytesEqual(raw.subarray(colon + 1), enc.encode(password));
    return userOk && passOk;
  } catch {
    return false;
  }
}

/** The 401 that asks the browser for the staging credentials (same realm everywhere, so one login covers every path). */
export function stagingChallenge(): Response {
  return new Response('Staging', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="OpenDrone staging", charset="UTF-8"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
