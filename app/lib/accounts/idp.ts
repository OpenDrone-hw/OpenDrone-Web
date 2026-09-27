/**
 * Identity providers behind opendrone.be sign-in (accounts contract,
 * "Identity provider interface"). Shopify Customer Accounts in production;
 * the test provider only on non-production hosts with ACCOUNTS_TEST_IDP=1.
 */
import {testIdpActive, type AccountsEnv} from './config.ts';
import {shopifyIdentityProvider} from './shopify-idp.ts';
import {testIdentityProvider} from './test-idp.ts';

export interface IdentityProvider {
  authorizeUrl(p: {state: string; nonce: string; codeChallenge: string; redirectUri: string; prompt?: 'none'}): Promise<string>;
  /** subject = Shopify customer GID. Access and refresh tokens are never returned. */
  exchangeCode(p: {code: string; codeVerifier: string; redirectUri: string; nonce: string}): Promise<{subject: string; idToken: string}>;
  logoutUrl(p: {idTokenHint: string; postLogoutRedirectUri: string}): Promise<string | null>;
}

export class IdpError extends Error {}

/** A Shopify customer GID (test customers use the same shape). */
export const CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/[A-Za-z0-9_-]{1,40}$/;

/** The provider for this request, or null when none is configured. */
export function identityProvider(env: AccountsEnv, request: Request, fetcher: typeof fetch = fetch): IdentityProvider | null {
  if (testIdpActive(env, request.url)) return testIdentityProvider(env, new URL(request.url).origin);
  return shopifyIdentityProvider(env, new URL(request.url).origin, fetcher);
}
