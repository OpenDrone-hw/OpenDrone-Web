/**
 * Sign-in and sign-out on opendrone.be (accounts design 4.1 flow A and
 * 4.2 "Sign-out"). The pre-login `__Host-od_oauth` cookie binds state,
 * nonce, PKCE verifier and return_to to this browser for 10 minutes.
 */
import {chatFpvBackchannelLogout, type BackchannelEnv} from './chatfpv-logout.ts';
import {
  accountHeaders,
  clearCookie,
  hostCookie,
  readCookie,
  redirectTo,
  safeReturnTo,
  sameOrigin,
  type AccountsEnv,
} from './config.ts';
import {openBlob, pkceChallenge, randomToken, safeEqual, signBlob} from './crypto.ts';
import {IdpError, type IdentityProvider} from './idp.ts';
import {clearSessionCookie, createSession, readSession, revokeSession, sessionCookie, sessionIdToken, upsertAccount} from './sessions.ts';

export const OAUTH_COOKIE = '__Host-od_oauth';
export const LOGOUT_COOKIE = '__Host-od_logout';
const OAUTH_TTL_SEC = 600;
const LABEL = 'od-oauth-state';

type LoginState = {s: string; n: string; v: string; r: string; exp: number};

export const callbackUri = (request: Request) => `${new URL(request.url).origin}/account/callback`;
/** Shopify's registered Logout URI; finishes a pending ChatFPV logout (oauth.ts). */
export const logoutReturnUri = (request: Request) => `${new URL(request.url).origin}/oauth/logout`;

function page(status: number, text: string): Response {
  return new Response(text, {status, headers: accountHeaders({'Content-Type': 'text/plain; charset=utf-8'})});
}

/** GET /account/login?return_to=<same-origin path> */
export async function startLogin(request: Request, env: AccountsEnv, idp: IdentityProvider | null, now = Date.now()): Promise<Response> {
  if (!idp || !env.SESSION_SECRET || !env.SUPPORT_DB) return page(503, 'Sign-in is not available right now.');
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('return_to'));
  const state = randomToken(32);
  const nonce = randomToken(32);
  const verifier = randomToken(48);
  let location: string;
  try {
    location = await idp.authorizeUrl({state, nonce, codeChallenge: await pkceChallenge(verifier), redirectUri: callbackUri(request)});
  } catch (err) {
    console.warn('[accounts] authorize url failed', err instanceof Error ? err.message : 'error');
    return page(503, 'Sign-in is not available right now.');
  }
  const blob = await signBlob(env.SESSION_SECRET, LABEL, {s: state, n: nonce, v: verifier, r: returnTo, exp: Math.floor(now / 1000) + OAUTH_TTL_SEC});
  return redirectTo(location, [hostCookie(OAUTH_COOKIE, blob, OAUTH_TTL_SEC)]);
}

/** GET /account/callback?code&state */
export async function finishLogin(request: Request, env: AccountsEnv, idp: IdentityProvider | null, now = Date.now()): Promise<Response> {
  const db = env.SUPPORT_DB;
  if (!idp || !env.SESSION_SECRET || !db) return page(503, 'Sign-in is not available right now.');
  const url = new URL(request.url);
  const raw = readCookie(request, OAUTH_COOKIE);
  const saved = raw ? await openBlob<LoginState>(env.SESSION_SECRET, LABEL, raw, Math.floor(now / 1000)) : null;
  const state = url.searchParams.get('state') ?? '';
  // Foreign or replayed state (login CSRF): refuse without touching the IdP.
  if (!saved || !state || !safeEqual(saved.s, state)) {
    return page(400, 'This sign-in link expired or was started in another browser. Please sign in again.');
  }
  const clear = clearCookie(OAUTH_COOKIE);
  const code = url.searchParams.get('code');
  if (!code) return redirectTo(saved.r, [clear]);
  let subject: string;
  let idToken: string;
  try {
    ({subject, idToken} = await idp.exchangeCode({code, codeVerifier: saved.v, redirectUri: callbackUri(request), nonce: saved.n}));
  } catch (err) {
    console.warn('[accounts] code exchange failed', err instanceof IdpError ? err.message : 'error');
    return page(400, 'Sign-in failed. Please try again.');
  }
  const accountId = await upsertAccount(db, subject, now);
  // Rotate: any session this browser still had is revoked.
  const previous = await readSession(db, request, now);
  if (previous) await revokeSession(db, previous.sid, now);
  const {cookieValue} = await createSession(db, env, accountId, idToken, now);
  return redirectTo(saved.r, [clear, sessionCookie(cookieValue)]);
}

/**
 * Revoke the session, tell ChatFPV (back-channel, over the binding) and
 * return where the browser goes next: Shopify's end_session when a real
 * id_token exists (it comes back to /oauth/logout), else `fallback`.
 */
export async function endSession(
  request: Request,
  env: AccountsEnv & BackchannelEnv,
  idp: IdentityProvider | null,
  fallback: string,
  now = Date.now(),
): Promise<string> {
  const db = env.SUPPORT_DB;
  const session = db ? await readSession(db, request, now) : null;
  if (!db || !session) return fallback;
  await revokeSession(db, session.sid, now);
  await chatFpvBackchannelLogout(env, session.sid);
  const idToken = await sessionIdToken(env, session);
  if (!idToken || !idp) return fallback;
  try {
    return (await idp.logoutUrl({idTokenHint: idToken, postLogoutRedirectUri: logoutReturnUri(request)})) ?? fallback;
  } catch {
    return fallback;
  }
}

/** POST /account/logout (same Origin only). */
export async function logout(request: Request, env: AccountsEnv & BackchannelEnv, idp: IdentityProvider | null, now = Date.now()): Promise<Response> {
  if (request.method !== 'POST' || !sameOrigin(request)) return page(403, 'Forbidden');
  const next = await endSession(request, env, idp, '/', now);
  return redirectTo(next, [clearSessionCookie()], 303);
}
