/**
 * Shopify Customer Account API as an OpenID Connect provider: discovery
 * (`<issuer>/.well-known/openid-configuration`), PKCE S256, nonce checked.
 * A Hydrogen channel storefront gets a public client (Client ID only, the
 * token call carries `client_id` and an `Origin` listed under JavaScript
 * origins); a Headless channel confidential client adds its secret as
 * client_secret_basic when SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET is set. The access and
 * refresh tokens in the token response are dropped on the spot; only the
 * id_token is kept (sealed) as the logout hint.
 *
 * The id_token comes straight from the token endpoint over TLS in the
 * PKCE-bound code exchange, so its claims are checked (iss, aud, exp,
 * nonce) and its signature is not (OpenID Connect Core 3.1.3.7, item 6).
 */
import type {AccountsEnv} from './config.ts';
import {textFromB64url} from './crypto.ts';
import {CUSTOMER_GID, IdpError, type IdentityProvider} from './idp.ts';

/**
 * Data minimisation (GDPR Art 5(1)(c), 25): only the id_token's `sub` is
 * used, and the access token is dropped unread, so `customer-account-api:full`
 * (API access to orders and addresses) is not requested. `openid` is needed
 * for the id_token. `email` stays: Shopify's Customer Account API reference
 * lists `openid email customer-account-api:full` as the scope and documents
 * no narrower accepted value, and its sign-in is an email one-time code, so
 * the email is already known to Shopify, never to opendrone.be (the id_token
 * is kept sealed only as the logout hint). If Shopify refuses this scope,
 * SHOPIFY_CUSTOMER_ACCOUNT_SCOPE widens it without a code change.
 */
export const SHOPIFY_SCOPE = 'openid email';
const KNOWN_SCOPES = new Set(['openid', 'email', 'customer-account-api:full']);

/** The scope to request: the env override when every token is a known scope and `openid` is in it, else SHOPIFY_SCOPE. */
export function shopifyScope(env: AccountsEnv): string {
  const tokens = (env.SHOPIFY_CUSTOMER_ACCOUNT_SCOPE ?? '').trim().split(/\s+/).filter(Boolean);
  return tokens.length && tokens.includes('openid') && tokens.every((t) => KNOWN_SCOPES.has(t)) ? tokens.join(' ') : SHOPIFY_SCOPE;
}

type Discovery = {issuer: string; authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string};

const discoveryCache = new Map<string, {at: number; value: Promise<Discovery>}>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Discovery base: SHOPIFY_CUSTOMER_ACCOUNT_ISSUER, else https://shopify.com/authentication/<shop id>. */
export function shopifyIssuer(env: AccountsEnv): string | null {
  const issuer = env.SHOPIFY_CUSTOMER_ACCOUNT_ISSUER?.trim();
  if (issuer) return /^https:\/\/[^\s]+$/.test(issuer) ? issuer.replace(/\/+$/, '') : null;
  const shopId = env.SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID?.trim();
  return shopId && /^\d+$/.test(shopId) ? `https://shopify.com/authentication/${shopId}` : null;
}

function httpsUrl(value: unknown): value is string {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

async function discover(issuer: string, origin: string, fetcher: typeof fetch, now: number): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && now - hit.at < DISCOVERY_TTL_MS) return hit.value;
  const value = (async () => {
    // Shopify answers 403 to a Worker fetch without Origin and User-Agent, as on the token call.
    const res = await fetcher(`${issuer}/.well-known/openid-configuration`, {
      headers: {Accept: 'application/json', Origin: origin, 'User-Agent': 'opendrone-web'},
    });
    if (!res.ok) throw new IdpError(`discovery ${res.status}`);
    const d = (await res.json()) as Partial<Discovery>;
    if (!httpsUrl(d.authorization_endpoint) || !httpsUrl(d.token_endpoint) || typeof d.issuer !== 'string') {
      throw new IdpError('discovery document incomplete');
    }
    return {
      issuer: d.issuer,
      authorization_endpoint: d.authorization_endpoint,
      token_endpoint: d.token_endpoint,
      ...(httpsUrl(d.end_session_endpoint) ? {end_session_endpoint: d.end_session_endpoint} : {}),
    };
  })();
  discoveryCache.set(issuer, {at: now, value});
  value.catch(() => discoveryCache.delete(issuer));
  return value;
}

/** Shopify's id_token `sub` as a customer GID (a bare numeric id gets the GID prefix). */
export function customerGid(sub: unknown): string | null {
  if (typeof sub !== 'string') return null;
  const gid = /^\d+$/.test(sub) ? `gid://shopify/Customer/${sub}` : sub;
  return CUSTOMER_GID.test(gid) ? gid : null;
}

export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(textFromB64url(parts[1])) as unknown;
    return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function shopifyIdentityProvider(
  env: AccountsEnv,
  origin: string,
  fetcher: typeof fetch = fetch,
  now: () => number = () => Date.now(),
): IdentityProvider | null {
  const issuer = shopifyIssuer(env);
  const clientId = env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID?.trim();
  const clientSecret = env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET?.trim();
  if (!issuer || !clientId) return null;
  const config = () => discover(issuer, origin, fetcher, now());

  return {
    async authorizeUrl(p) {
      const d = await config();
      const url = new URL(d.authorization_endpoint);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', p.redirectUri);
      url.searchParams.set('scope', shopifyScope(env));
      url.searchParams.set('state', p.state);
      url.searchParams.set('nonce', p.nonce);
      url.searchParams.set('code_challenge', p.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      if (p.prompt) url.searchParams.set('prompt', p.prompt);
      return url.toString();
    },

    async exchangeCode(p) {
      const d = await config();
      const res = await fetcher(d.token_endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...(clientSecret ? {Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`} : {}),
          // Shopify refuses token calls from a Worker without these.
          Origin: origin,
          'User-Agent': 'opendrone-web',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          redirect_uri: p.redirectUri,
          code: p.code,
          code_verifier: p.codeVerifier,
        }).toString(),
      });
      if (!res.ok) throw new IdpError(`token ${res.status}`);
      // Only id_token is read; access_token and refresh_token go out of scope here.
      const {id_token: idToken} = (await res.json()) as {id_token?: unknown};
      if (typeof idToken !== 'string') throw new IdpError('no id_token');
      const claims = decodeJwtPayload(idToken);
      if (!claims) throw new IdpError('malformed id_token');
      const aud = claims.aud;
      const audOk = aud === clientId || (Array.isArray(aud) && aud.includes(clientId));
      if (claims.iss !== d.issuer || !audOk) throw new IdpError('id_token issuer or audience');
      if (typeof claims.exp !== 'number' || claims.exp * 1000 < now() - 60_000) throw new IdpError('id_token expired');
      if (claims.nonce !== p.nonce) throw new IdpError('nonce mismatch');
      const subject = customerGid(claims.sub);
      if (!subject) {
        // The value never leaves the Worker; its shape (digits 9, letters a) shows what Shopify sends.
        const shape = typeof claims.sub === 'string' ? claims.sub.slice(0, 60).replace(/[0-9]/g, '9').replace(/[A-Za-z]/g, 'a') : typeof claims.sub;
        throw new IdpError(`id_token subject shape ${shape}`);
      }
      return {subject, idToken};
    },

    async logoutUrl(p) {
      const d = await config();
      if (!d.end_session_endpoint || !p.idTokenHint) return null;
      const url = new URL(d.end_session_endpoint);
      url.searchParams.set('id_token_hint', p.idTokenHint);
      url.searchParams.set('post_logout_redirect_uri', p.postLogoutRedirectUri);
      return url.toString();
    },
  };
}
