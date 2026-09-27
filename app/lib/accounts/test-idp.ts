/**
 * Test identity provider (accounts contract): a form at
 * /account/test-idp/authorize picks a test customer and returns a stateless
 * code = HMAC(SESSION_SECRET) over {gid, nonce, challenge, redirect_uri,
 * exp 60 s}. Selected only by `testIdpActive` (config.ts): never on
 * opendrone.be or www.opendrone.be.
 */
import type {AccountsEnv} from './config.ts';
import {openBlob, pkceChallenge, PKCE_VALUE, safeEqual, signBlob} from './crypto.ts';
import {CUSTOMER_GID, IdpError, type IdentityProvider} from './idp.ts';

export const TEST_CUSTOMERS = ['gid://shopify/Customer/test-1', 'gid://shopify/Customer/test-2'] as const;
export const TEST_IDP_PATH = '/account/test-idp/authorize';
const LABEL = 'od-test-idp-code';
const CODE_TTL_SEC = 60;

type TestCode = {gid: string; nonce: string; challenge: string; redirect_uri: string; exp: number};

function secret(env: AccountsEnv): string {
  if (!env.SESSION_SECRET) throw new IdpError('SESSION_SECRET missing');
  return env.SESSION_SECRET;
}

/** The code the test form returns, after validating its inputs. */
export async function issueTestCode(
  env: AccountsEnv,
  origin: string,
  p: {gid: string; nonce: string; challenge: string; redirectUri: string},
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (!CUSTOMER_GID.test(p.gid)) throw new IdpError('invalid customer');
  if (p.redirectUri !== `${origin}/account/callback`) throw new IdpError('invalid redirect_uri');
  if (!PKCE_VALUE.test(p.challenge) || !p.nonce || p.nonce.length > 128) throw new IdpError('invalid request');
  return signBlob(secret(env), LABEL, {gid: p.gid, nonce: p.nonce, challenge: p.challenge, redirect_uri: p.redirectUri, exp: nowSec + CODE_TTL_SEC});
}

export function testIdentityProvider(env: AccountsEnv, origin: string, now: () => number = () => Date.now()): IdentityProvider {
  return {
    async authorizeUrl(p) {
      const url = new URL(TEST_IDP_PATH, origin);
      url.searchParams.set('state', p.state);
      url.searchParams.set('nonce', p.nonce);
      url.searchParams.set('code_challenge', p.codeChallenge);
      url.searchParams.set('redirect_uri', p.redirectUri);
      return url.toString();
    },
    async exchangeCode(p) {
      const code = await openBlob<TestCode>(secret(env), LABEL, p.code, Math.floor(now() / 1000));
      if (!code) throw new IdpError('invalid or expired code');
      if (code.redirect_uri !== p.redirectUri) throw new IdpError('redirect_uri mismatch');
      if (!safeEqual(code.challenge, await pkceChallenge(p.codeVerifier))) throw new IdpError('PKCE mismatch');
      if (!safeEqual(code.nonce, p.nonce)) throw new IdpError('nonce mismatch');
      // No id_token: sign-out skips the Shopify end_session step.
      return {subject: code.gid, idToken: ''};
    },
    async logoutUrl() {
      return null;
    },
  };
}
