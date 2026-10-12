/**
 * Authentication of the staff API (/api/staff/support/*), for the internal
 * app (incutec-app) only:
 *
 * 1. A bearer token, SUPPORT_STAFF_API_TOKEN, compared in constant time.
 * 2. When SUPPORT_STAFF_ACCESS_TEAM_DOMAIN and SUPPORT_STAFF_ACCESS_AUD are
 *    set, also a Cloudflare Access JWT (header Cf-Access-Jwt-Assertion): RS256
 *    signature against the team's certs, audience, issuer, expiry and, when
 *    SUPPORT_STAFF_ACCESS_CLIENT_ID is set, the service token it was issued to.
 *
 * The person is named by the X-Staff-Login header the app sends. It is an
 * audit label, not a credential: whoever holds the token can set it.
 */

export type StaffAuthEnv = {
  SUPPORT_STAFF_API_TOKEN?: string;
  SUPPORT_STAFF_ACCESS_TEAM_DOMAIN?: string;
  SUPPORT_STAFF_ACCESS_AUD?: string;
  SUPPORT_STAFF_ACCESS_CLIENT_ID?: string;
};

export type StaffAuth = {ok: true; login: string | null} | {ok: false; status: 401 | 403 | 503; error: string};

const LOGIN_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
export const validLogin = (s: string | null | undefined): s is string => typeof s === 'string' && LOGIN_RE.test(s);

const enc = new TextEncoder();

/** Compares SHA-256 digests, so neither the content nor the length of the secret shows in the timing. */
async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([a, b].map(async (v) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(v)))));
  let diff = 0;
  for (let i = 0; i < x!.length; i++) diff |= x![i]! ^ y![i]!;
  return diff === 0;
}

export function accessConfigured(env: StaffAuthEnv): boolean {
  return Boolean(env.SUPPORT_STAFF_ACCESS_TEAM_DOMAIN && env.SUPPORT_STAFF_ACCESS_AUD);
}

function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : '';
  const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

type Jwk = {kid?: string} & Record<string, unknown>;
const certCache = new Map<string, {at: number; keys: Jwk[]}>();
const CERT_TTL_MS = 10 * 60 * 1000;

export function _resetAccessCache(): void {
  certCache.clear();
}

async function certs(team: string, fetcher: typeof fetch, now: number, fresh = false): Promise<Jwk[]> {
  const hit = certCache.get(team);
  if (hit && !fresh && now - hit.at < CERT_TTL_MS) return hit.keys;
  const res = await fetcher(`https://${team}/cdn-cgi/access/certs`, {headers: {Accept: 'application/json'}});
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const keys = ((await res.json()) as {keys?: Jwk[]}).keys ?? [];
  certCache.set(team, {at: now, keys});
  return keys;
}

/** True when the JWT is a valid Access token for this application (and service token, when pinned). */
export async function verifyAccessJwt(env: StaffAuthEnv, jwt: string | null, fetcher: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  if (!jwt || jwt.length > 8192) return false;
  const parts = jwt.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(unb64url(parts[0]!))) as {alg?: string; kid?: string};
    const payload = JSON.parse(new TextDecoder().decode(unb64url(parts[1]!))) as {aud?: string | string[]; iss?: string; exp?: number; nbf?: number; common_name?: string};
    if (header.alg !== 'RS256') return false;
    const team = env.SUPPORT_STAFF_ACCESS_TEAM_DOMAIN!;
    let key = (await certs(team, fetcher, now)).find((k) => k.kid === header.kid);
    if (!key) key = (await certs(team, fetcher, now, true)).find((k) => k.kid === header.kid);
    if (!key) return false;
    const pub = await crypto.subtle.importKey('jwk', key as JsonWebKey, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['verify']);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, unb64url(parts[2]!), enc.encode(`${parts[0]}.${parts[1]}`)))) return false;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.SUPPORT_STAFF_ACCESS_AUD)) return false;
    if (payload.iss !== `https://${team}`) return false;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) return false;
    if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now + 60_000) return false;
    const client = env.SUPPORT_STAFF_ACCESS_CLIENT_ID;
    if (client && !(typeof payload.common_name === 'string' && (await secretsEqual(payload.common_name, client)))) return false;
    return true;
  } catch {
    return false;
  }
}

export async function authenticateStaff(request: Request, env: StaffAuthEnv, fetcher: typeof fetch = fetch, now = Date.now()): Promise<StaffAuth> {
  const token = env.SUPPORT_STAFF_API_TOKEN;
  if (!token) return {ok: false, status: 503, error: 'staff_api_not_configured'};
  const given = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1]?.trim() ?? '';
  if (!given || !(await secretsEqual(given, token))) return {ok: false, status: 401, error: 'unauthorized'};
  if (accessConfigured(env) && !(await verifyAccessJwt(env, request.headers.get('Cf-Access-Jwt-Assertion'), fetcher, now))) {
    return {ok: false, status: 403, error: 'access_denied'};
  }
  const login = request.headers.get('X-Staff-Login')?.trim() ?? '';
  return {ok: true, login: validLogin(login) ? login : null};
}
