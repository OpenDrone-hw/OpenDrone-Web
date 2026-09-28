/**
 * The authorization server chatfpv.com signs in against (accounts contract
 * "/oauth/authorize", "/oauth/token"; design section 6). One static client
 * `chatfpv`, exact redirect URIs from CHATFPV_OAUTH_REDIRECTS, PKCE S256,
 * 60-second single-use codes stored hashed; a replayed code revokes the
 * session it was issued for (RFC 9700). `iss` (RFC 9207) is the storefront
 * origin of the request.
 */
import type {BackchannelEnv} from './chatfpv-logout.ts';
import {
  accountHeaders,
  accountsEnabled,
  allowlist,
  CHATFPV_CLIENT_ID,
  clearCookie,
  hostCookie,
  isBindingRequest,
  jsonResponse,
  notFound,
  readCookie,
  redirectTo,
  testIdpActive,
  type AccountsEnv,
} from './config.ts';
import {openBlob, pairwiseSub, pkceChallenge, PKCE_VALUE, randomToken, safeEqual, sha256Hex, signBlob} from './crypto.ts';
import type {IdentityProvider} from './idp.ts';
import {clearSessionCookie, readSession, revokeSession} from './sessions.ts';
import {endSession, LOGOUT_COOKIE} from './signin.ts';

export const CODE_TTL_MS = 60_000;
const LOGOUT_TTL_SEC = 300;
const LOGOUT_LABEL = 'od-logout';

const issuer = (request: Request) => new URL(request.url).origin;

function withParams(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

function badRequest(text: string): Response {
  return new Response(text, {status: 400, headers: accountHeaders({'Content-Type': 'text/plain; charset=utf-8'})});
}

/** GET /oauth/authorize */
export async function authorize(request: Request, env: AccountsEnv, now = Date.now()): Promise<Response> {
  if (!accountsEnabled(env)) return notFound();
  const db = env.SUPPORT_DB;
  if (!db) return new Response('Sign-in is not available right now.', {status: 503, headers: accountHeaders()});
  const url = new URL(request.url);
  const q = url.searchParams;
  const redirectUri = q.get('redirect_uri') ?? '';
  // Never redirect to an unverified client or URI: answer here instead.
  if (q.get('client_id') !== CHATFPV_CLIENT_ID || !allowlist(env.CHATFPV_OAUTH_REDIRECTS).includes(redirectUri)) {
    return badRequest('Unknown client or redirect_uri.');
  }
  const state = q.get('state') ?? '';
  const iss = issuer(request);
  const back = (params: Record<string, string>) => redirectTo(withParams(redirectUri, {...params, ...(state ? {state} : {}), iss}));
  const challenge = q.get('code_challenge') ?? '';
  const responseType = q.get('response_type');
  if (
    !state ||
    state.length > 512 ||
    !PKCE_VALUE.test(challenge) ||
    q.get('code_challenge_method') !== 'S256' ||
    (responseType !== null && responseType !== 'code')
  ) {
    return back({error: 'invalid_request'});
  }
  const session = await readSession(db, request, now);
  if (!session) {
    if (q.get('prompt') === 'none') return back({error: 'login_required'});
    return redirectTo(`/account/login?return_to=${encodeURIComponent(url.pathname + url.search)}`);
  }
  const code = randomToken(32);
  await db
    .prepare(
      'INSERT INTO oauth_codes (code_hash, client_id, account_id, sid, redirect_uri, code_challenge, nonce, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
    )
    .bind(await sha256Hex(code), CHATFPV_CLIENT_ID, session.accountId, session.sid, redirectUri, challenge, now + CODE_TTL_MS)
    .run();
  const res = back({code});
  if (session.refreshCookie) res.headers.append('Set-Cookie', session.refreshCookie);
  return res;
}

/**
 * Whether POST /oauth/token is reachable for this request: over the
 * service binding always, on the public host only while the test IdP rule
 * is active (staging E2E). server.ts uses the same test to skip the staging
 * basic-auth gate for it.
 */
export function tokenEndpointReachable(request: Request, env: AccountsEnv): boolean {
  if (!accountsEnabled(env)) return false;
  return isBindingRequest(request) || testIdpActive(env, request.url);
}

type TokenResult = {sub: string; sid: string; auth_time: number; iss: string};

/** POST /oauth/token (form encoded). */
export async function token(request: Request, env: AccountsEnv, now = Date.now()): Promise<Response> {
  if (!tokenEndpointReachable(request, env) || request.method !== 'POST') return notFound();
  const db = env.SUPPORT_DB;
  const secret = env.CHATFPV_OAUTH_CLIENT_SECRET ?? '';
  const salt = env.ACCOUNT_PAIRWISE_SALT ?? '';
  if (!db || !secret || !salt) return jsonResponse({error: 'server_error'}, 503);
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return jsonResponse({error: 'invalid_request'}, 400);
  }
  if (form.get('client_id') !== CHATFPV_CLIENT_ID || !safeEqual(form.get('client_secret') ?? '', secret)) {
    return jsonResponse({error: 'invalid_client'}, 400);
  }
  const invalid = () => jsonResponse({error: 'invalid_grant'}, 400);
  const code = form.get('code') ?? '';
  if (form.get('grant_type') !== 'authorization_code' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return invalid();
  const hash = await sha256Hex(code);
  const row = await db
    .prepare('SELECT account_id, sid, redirect_uri, code_challenge, expires_at, used_at FROM oauth_codes WHERE code_hash = ? AND client_id = ?')
    .bind(hash, CHATFPV_CLIENT_ID)
    .first<{account_id: string; sid: string; redirect_uri: string; code_challenge: string; expires_at: number; used_at: number | null}>();
  if (!row) return invalid();
  // Burn the code first; losing the race or finding it used means replay.
  const burned = await db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').bind(now, hash).run();
  if (row.used_at !== null || !burned.meta.changes) {
    await revokeSession(db, row.sid, now);
    return invalid();
  }
  if (row.expires_at <= now) return invalid();
  if (form.get('redirect_uri') !== row.redirect_uri) return invalid();
  const verifier = form.get('code_verifier') ?? '';
  if (!PKCE_VALUE.test(verifier) || !safeEqual(await pkceChallenge(verifier), row.code_challenge)) return invalid();
  const session = await db
    .prepare(
      'SELECT s.created_at, a.shopify_gid FROM od_sessions s JOIN od_accounts a ON a.id = s.account_id WHERE s.id_hash = ? AND s.account_id = ? AND s.revoked_at IS NULL AND s.expires_at > ?',
    )
    .bind(row.sid, row.account_id, now)
    .first<{created_at: number; shopify_gid: string}>();
  if (!session) return invalid();
  const body: TokenResult = {
    sub: await pairwiseSub(salt, session.shopify_gid),
    sid: row.sid,
    auth_time: Math.floor(session.created_at / 1000),
    iss: issuer(request),
  };
  return jsonResponse(body);
}

/**
 * GET /oauth/logout: RP-initiated logout from chatfpv.com.
 * `post_logout_redirect_uri` must be on CHATFPV_POST_LOGOUT_REDIRECTS. When
 * Shopify's end_session is needed, the target waits in a 5-minute signed
 * cookie and Shopify sends the browser back here (its registered Logout
 * URI), which then finishes the redirect. Without a parameter or cookie it
 * lands on "/".
 */
export async function oauthLogout(
  request: Request,
  env: AccountsEnv & BackchannelEnv,
  idp: IdentityProvider | null,
  now = Date.now(),
): Promise<Response> {
  if (!accountsEnabled(env) || !env.SESSION_SECRET) return notFound();
  const q = new URL(request.url).searchParams;
  const target = q.get('post_logout_redirect_uri');
  const nowSec = Math.floor(now / 1000);
  if (target === null) {
    const pending = readCookie(request, LOGOUT_COOKIE);
    const saved = pending ? await openBlob<{t: string; s?: string; exp: number}>(env.SESSION_SECRET, LOGOUT_LABEL, pending, nowSec) : null;
    const ok = saved && allowlist(env.CHATFPV_POST_LOGOUT_REDIRECTS).includes(saved.t);
    const next = ok ? (saved.s ? withParams(saved.t, {state: saved.s}) : saved.t) : '/';
    return redirectTo(next, [clearCookie(LOGOUT_COOKIE), clearSessionCookie()]);
  }
  if (!allowlist(env.CHATFPV_POST_LOGOUT_REDIRECTS).includes(target)) return badRequest('Unknown post_logout_redirect_uri.');
  const state = q.get('state');
  const finalTarget = state && state.length <= 512 ? withParams(target, {state}) : target;
  const next = await endSession(request, env, idp, finalTarget, now);
  const cookies = [clearSessionCookie()];
  if (next !== finalTarget) {
    // Via Shopify: remember where to go once it returns to /oauth/logout.
    cookies.push(hostCookie(LOGOUT_COOKIE, await signBlob(env.SESSION_SECRET, LOGOUT_LABEL, {t: target, ...(finalTarget !== target ? {s: state} : {}), exp: nowSec + LOGOUT_TTL_SEC}), LOGOUT_TTL_SEC));
  }
  return redirectTo(next, cookies);
}
