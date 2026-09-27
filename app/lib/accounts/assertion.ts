/**
 * Widget assertion (accounts contract "Widget assertion"):
 * `v1.<b64url(JSON{sub,aud:"chatfpv-widget",iat,exp})>.<b64url(HMAC-SHA256(WIDGET_ASSERTION_KEY, "v1."+payload))>`,
 * 5 minutes. GET /api/account/widget-assertion returns it to the page,
 * which posts it into the ChatFPV iframe; 204 when signed out.
 */
import {accountHeaders, accountsEnabled, jsonResponse, notFound, type AccountsEnv} from './config.ts';
import {b64urlText, hmacB64url, pairwiseSub} from './crypto.ts';
import {clearSessionCookie, hasSessionCookie, readSession} from './sessions.ts';

export const ASSERTION_AUD = 'chatfpv-widget';
export const ASSERTION_TTL_SEC = 300;

export async function signAssertion(key: string, sub: string, nowSec = Math.floor(Date.now() / 1000)): Promise<{assertion: string; exp: number}> {
  const exp = nowSec + ASSERTION_TTL_SEC;
  const payload = b64urlText(JSON.stringify({sub, aud: ASSERTION_AUD, iat: nowSec, exp}));
  return {assertion: `v1.${payload}.${await hmacB64url(key, `v1.${payload}`)}`, exp};
}

/** GET /api/account/widget-assertion (same-origin browser fetch). */
export async function widgetAssertion(request: Request, env: AccountsEnv, now = Date.now()): Promise<Response> {
  if (!accountsEnabled(env)) return notFound();
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return new Response(null, {status: 403, headers: accountHeaders()});
  const session = await readSession(env.SUPPORT_DB, request, now);
  if (!session || !env.WIDGET_ASSERTION_KEY || !env.ACCOUNT_PAIRWISE_SALT) {
    const headers = accountHeaders();
    // A stale cookie (expired or revoked session) goes, so the header says "Sign in" again.
    if (!session && hasSessionCookie(request)) headers.append('Set-Cookie', clearSessionCookie());
    return new Response(null, {status: 204, headers});
  }
  const sub = await pairwiseSub(env.ACCOUNT_PAIRWISE_SALT, session.shopifyGid);
  const res = jsonResponse(await signAssertion(env.WIDGET_ASSERTION_KEY, sub, Math.floor(now / 1000)));
  if (session.refreshCookie) res.headers.append('Set-Cookie', session.refreshCookie);
  return res;
}

/** The pairwise sub of the signed-in shopper, for the Ask box (`X-ChatFPV-Account`). */
export async function accountSubFor(request: Request, env: AccountsEnv): Promise<string | null> {
  if (!accountsEnabled(env) || !env.ACCOUNT_PAIRWISE_SALT) return null;
  const session = await readSession(env.SUPPORT_DB, request);
  return session ? pairwiseSub(env.ACCOUNT_PAIRWISE_SALT, session.shopifyGid) : null;
}
