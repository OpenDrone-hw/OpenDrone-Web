import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {testD1} from '../support/testing.ts';
import {ASSERTION_AUD, ASSERTION_TTL_SEC, signAssertion, widgetAssertion} from './assertion.ts';
import {chatFpvBackchannelLogout} from './chatfpv-logout.ts';
import {accountHeaders, safeReturnTo, testIdpActive, type AccountsEnv} from './config.ts';
import {b64url, hmacB64url, pairwiseSub, pkceChallenge, randomToken, seal, textFromB64url, unseal} from './crypto.ts';
import {identityProvider} from './idp.ts';
import {authorize, oauthLogout, token} from './oauth.ts';
import {createSession, readSession, SESSION_COOKIE, upsertAccount} from './sessions.ts';
import {customerGid, shopifyIdentityProvider, shopifyScope} from './shopify-idp.ts';
import {finishLogin, OAUTH_COOKIE, startLogin} from './signin.ts';
import {issueTestCode, testIdentityProvider} from './test-idp.ts';
import {frameOrigin, postAssertion, refreshDelayMs} from './widget-client.ts';

const STAGING = 'https://abc-opendrone-web-preview.sales-ee0.workers.dev';
const REDIRECT = 'https://chatfpv.com/auth/callback';
const SECRET = 'client-secret-for-tests';
const GID = 'gid://shopify/Customer/test-1';

async function env(extra: Partial<AccountsEnv> = {}): Promise<AccountsEnv> {
  const db = await testD1();
  assert.ok(db, 'node:sqlite required');
  return {
    ACCOUNTS_ENABLED: '1',
    SESSION_SECRET: 'session-secret',
    SESSION_ENC_KEY: 'enc-key',
    ACCOUNT_PAIRWISE_SALT: 'pairwise-salt',
    WIDGET_ASSERTION_KEY: 'assertion-key',
    CHATFPV_OAUTH_CLIENT_SECRET: SECRET,
    CHATFPV_OAUTH_REDIRECTS: `${REDIRECT},https://preview.chatfpv.example/auth/callback`,
    CHATFPV_POST_LOGOUT_REDIRECTS: 'https://chatfpv.com/',
    SUPPORT_DB: db,
    ...extra,
  };
}

/** A signed-in browser: account + session, returns the Cookie header. */
async function signedIn(e: AccountsEnv, gid = GID, idToken = ''): Promise<{cookie: string; sid: string}> {
  const accountId = await upsertAccount(e.SUPPORT_DB!, gid);
  const {cookieValue, sid} = await createSession(e.SUPPORT_DB!, e, accountId, idToken);
  return {cookie: `${SESSION_COOKIE}=${cookieValue}`, sid};
}

const verifier = () => randomToken(48);

async function authorizeCode(e: AccountsEnv, cookie: string, v: string, redirect = REDIRECT, origin = 'https://opendrone.be'): Promise<string> {
  const url = new URL('/oauth/authorize', origin);
  url.search = new URLSearchParams({client_id: 'chatfpv', redirect_uri: redirect, state: 'st', code_challenge: await pkceChallenge(v), code_challenge_method: 'S256'}).toString();
  const res = await authorize(new Request(url, {headers: {Cookie: cookie}}), e);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location')!);
  assert.equal(loc.searchParams.get('state'), 'st');
  assert.equal(loc.searchParams.get('iss'), origin);
  return loc.searchParams.get('code')!;
}

function tokenRequest(fields: Record<string, string>, opts: {origin?: string; publicHost?: boolean} = {}): Request {
  return new Request(`${opts.origin ?? 'https://opendrone.be'}/oauth/token`, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', ...(opts.publicHost ? {'CF-Connecting-IP': '203.0.113.9'} : {})},
    body: new URLSearchParams({grant_type: 'authorization_code', client_id: 'chatfpv', client_secret: SECRET, redirect_uri: REDIRECT, ...fields}).toString(),
  });
}

describe('oauth authorize and token', () => {
  it('issues a code and exchanges it for the pairwise sub, sid and iss', async () => {
    const e = await env();
    const {cookie, sid} = await signedIn(e);
    const v = verifier();
    const code = await authorizeCode(e, cookie, v);
    const res = await token(tokenRequest({code, code_verifier: v}), e);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.sub, await pairwiseSub('pairwise-salt', GID));
    assert.equal(body.sid, sid);
    assert.equal(body.iss, 'https://opendrone.be');
    assert.equal(typeof body.auth_time, 'number');
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });

  it('refuses a PKCE mismatch', async () => {
    const e = await env();
    const {cookie} = await signedIn(e);
    const code = await authorizeCode(e, cookie, verifier());
    const res = await token(tokenRequest({code, code_verifier: verifier()}), e);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {error: 'invalid_grant'});
  });

  it('a reused code is refused and revokes the session', async () => {
    const e = await env();
    const {cookie} = await signedIn(e);
    const v = verifier();
    const code = await authorizeCode(e, cookie, v);
    assert.equal((await token(tokenRequest({code, code_verifier: v}), e)).status, 200);
    const again = await token(tokenRequest({code, code_verifier: v}), e);
    assert.equal(again.status, 400);
    assert.equal(await readSession(e.SUPPORT_DB, new Request('https://opendrone.be/', {headers: {Cookie: cookie}})), null);
    // A fresh authorize now finds no session.
    const url = `https://opendrone.be/oauth/authorize?client_id=chatfpv&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=${await pkceChallenge(v)}&code_challenge_method=S256&prompt=none`;
    const res = await authorize(new Request(url, {headers: {Cookie: cookie}}), e);
    assert.equal(new URL(res.headers.get('Location')!).searchParams.get('error'), 'login_required');
  });

  it('refuses a wrong redirect_uri at the token endpoint and an unlisted one at authorize', async () => {
    const e = await env();
    const {cookie} = await signedIn(e);
    const v = verifier();
    const code = await authorizeCode(e, cookie, v);
    const res = await token(tokenRequest({code, code_verifier: v, redirect_uri: 'https://preview.chatfpv.example/auth/callback'}), e);
    assert.equal(res.status, 400);
    const bad = `https://opendrone.be/oauth/authorize?client_id=chatfpv&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&state=s&code_challenge=${await pkceChallenge(v)}&code_challenge_method=S256`;
    const r2 = await authorize(new Request(bad, {headers: {Cookie: cookie}}), e);
    assert.equal(r2.status, 400);
    assert.equal(r2.headers.get('Location'), null);
    assert.match(r2.headers.get('Content-Security-Policy') ?? '', /frame-ancestors 'none'/);
  });

  it('refuses an expired code', async () => {
    const e = await env();
    const {cookie} = await signedIn(e);
    const v = verifier();
    const code = await authorizeCode(e, cookie, v);
    const res = await token(tokenRequest({code, code_verifier: v}), e, Date.now() + 61_000);
    assert.equal(res.status, 400);
  });

  it('refuses a wrong client secret', async () => {
    const e = await env();
    const {cookie} = await signedIn(e);
    const v = verifier();
    const code = await authorizeCode(e, cookie, v);
    const res = await token(tokenRequest({code, code_verifier: v, client_secret: 'nope'}), e);
    assert.deepEqual(await res.json(), {error: 'invalid_client'});
  });

  it('prompt=none without a session returns login_required; otherwise sends to /account/login', async () => {
    const e = await env();
    const c = await pkceChallenge(verifier());
    const base = `https://opendrone.be/oauth/authorize?client_id=chatfpv&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s1&code_challenge=${c}&code_challenge_method=S256`;
    const silent = await authorize(new Request(`${base}&prompt=none`), e);
    const loc = new URL(silent.headers.get('Location')!);
    assert.equal(loc.origin + loc.pathname, REDIRECT);
    assert.equal(loc.searchParams.get('error'), 'login_required');
    assert.equal(loc.searchParams.get('state'), 's1');
    const loud = await authorize(new Request(base), e);
    assert.match(loud.headers.get('Location')!, /^\/account\/login\?return_to=%2Foauth%2Fauthorize%3F/);
  });

  it('token endpoint: 404 on the public host in production mode, reachable over the binding', async () => {
    const e = await env();
    const {cookie} = await signedIn(e);
    const v = verifier();
    const code = await authorizeCode(e, cookie, v);
    assert.equal((await token(tokenRequest({code, code_verifier: v}, {publicHost: true}), e)).status, 404);
    // Test IdP rule on: still 404 on opendrone.be, reachable on a staging host.
    const t = {...e, ACCOUNTS_TEST_IDP: '1'};
    assert.equal((await token(tokenRequest({code, code_verifier: v}, {publicHost: true}), t)).status, 404);
    assert.equal((await token(tokenRequest({code, code_verifier: v}, {publicHost: true, origin: STAGING}), t)).status, 200);
  });

  it('every account route is 404 with ACCOUNTS_ENABLED off', async () => {
    const e = await env({ACCOUNTS_ENABLED: '0'});
    assert.equal((await authorize(new Request('https://opendrone.be/oauth/authorize'), e)).status, 404);
    assert.equal((await token(tokenRequest({code: 'x'}), e)).status, 404);
    assert.equal((await widgetAssertion(new Request('https://opendrone.be/api/account/widget-assertion'), e)).status, 404);
    assert.equal((await oauthLogout(new Request('https://opendrone.be/oauth/logout'), e, null)).status, 404);
  });
  it('asks for the minimal scope; the override accepts only known scopes with openid', () => {
    assert.equal(shopifyScope({}), 'openid email');
    assert.equal(shopifyScope({SHOPIFY_CUSTOMER_ACCOUNT_SCOPE: 'openid'}), 'openid');
    assert.equal(shopifyScope({SHOPIFY_CUSTOMER_ACCOUNT_SCOPE: ' openid  email customer-account-api:full '}), 'openid email customer-account-api:full');
    assert.equal(shopifyScope({SHOPIFY_CUSTOMER_ACCOUNT_SCOPE: 'email'}), 'openid email');
    assert.equal(shopifyScope({SHOPIFY_CUSTOMER_ACCOUNT_SCOPE: 'openid write_orders'}), 'openid email');
  });
});

describe('sign-in', () => {
  it('login sets a state cookie and returns to a safe path; callback creates a session', async () => {
    const e = await env({ACCOUNTS_TEST_IDP: '1'});
    const req = new Request(`${STAGING}/account/login?return_to=${encodeURIComponent('/products/openfc-lite')}`);
    const idp = identityProvider(e, req);
    const start = await startLogin(req, e, idp);
    assert.equal(start.status, 302);
    const auth = new URL(start.headers.get('Location')!);
    assert.equal(auth.pathname, '/account/test-idp/authorize');
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_COOKIE}=`))!;
    assert.match(stateCookie, /HttpOnly; Secure; SameSite=Lax/);
    const cookie = stateCookie.split(';')[0];
    const code = await issueTestCode(e, STAGING, {
      gid: GID,
      nonce: auth.searchParams.get('nonce')!,
      challenge: auth.searchParams.get('code_challenge')!,
      redirectUri: auth.searchParams.get('redirect_uri')!,
    });
    const cb = new Request(`${STAGING}/account/callback?code=${code}&state=${auth.searchParams.get('state')}`, {headers: {Cookie: cookie}});
    const done = await finishLogin(cb, e, idp);
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('Location'), '/products/openfc-lite');
    const sid = done.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    assert.match(sid, /^__Host-od_sid=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
    const session = await readSession(e.SUPPORT_DB, new Request(STAGING, {headers: {Cookie: sid.split(';')[0]}}));
    assert.equal(session?.shopifyGid, GID);
  });

  it('refuses a foreign state', async () => {
    const e = await env({ACCOUNTS_TEST_IDP: '1'});
    const req = new Request(`${STAGING}/account/login`);
    const idp = identityProvider(e, req);
    const start = await startLogin(req, e, idp);
    const cookie = start.headers.getSetCookie()[0].split(';')[0];
    const res = await finishLogin(new Request(`${STAGING}/account/callback?code=x&state=${randomToken()}`, {headers: {Cookie: cookie}}), e, idp);
    assert.equal(res.status, 400);
    const none = await finishLogin(new Request(`${STAGING}/account/callback?code=x&state=y`), e, idp);
    assert.equal(none.status, 400);
  });

  it('return_to refuses //evil, https://evil and backslash tricks', () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '\\\\evil', 'javascript:alert(1)', '/%0a//evil', '']) {
      const got = safeReturnTo(bad);
      assert.ok(got === '/' || (got.startsWith('/') && !got.startsWith('//')), bad);
      assert.ok(!got.includes('evil.example') || got.startsWith('/%'), bad);
    }
    assert.equal(safeReturnTo('//evil.example'), '/');
    assert.equal(safeReturnTo('https://evil.example'), '/');
    assert.equal(safeReturnTo('/products/openfc-lite?variant=1#x'), '/products/openfc-lite?variant=1#x');
  });

  it('test IdP code checks PKCE and nonce', async () => {
    const e = await env();
    const idp = testIdentityProvider(e, STAGING);
    const v = verifier();
    const redirectUri = `${STAGING}/account/callback`;
    const code = await issueTestCode(e, STAGING, {gid: GID, nonce: 'n1', challenge: await pkceChallenge(v), redirectUri});
    await assert.rejects(idp.exchangeCode({code, codeVerifier: verifier(), redirectUri, nonce: 'n1'}), /PKCE/);
    await assert.rejects(idp.exchangeCode({code, codeVerifier: v, redirectUri, nonce: 'n2'}), /nonce/);
    assert.deepEqual(await idp.exchangeCode({code, codeVerifier: v, redirectUri, nonce: 'n1'}), {subject: GID, idToken: ''});
    await assert.rejects(issueTestCode(e, STAGING, {gid: GID, nonce: 'n', challenge: await pkceChallenge(v), redirectUri: 'https://evil.example/account/callback'}));
    await assert.rejects(issueTestCode(e, STAGING, {gid: 'gid://shopify/Customer/7012345678901', nonce: 'n', challenge: await pkceChallenge(v), redirectUri}), /test customers only/);
  });
});

describe('test IdP rule', () => {
  it('is refused on opendrone.be and www.opendrone.be even with ACCOUNTS_TEST_IDP=1', () => {
    const e: AccountsEnv = {ACCOUNTS_ENABLED: '1', ACCOUNTS_TEST_IDP: '1'};
    assert.equal(testIdpActive(e, 'https://opendrone.be/account/login'), false);
    assert.equal(testIdpActive(e, 'https://www.opendrone.be/account/login'), false);
    assert.equal(testIdpActive(e, 'https://OPENDRONE.BE./x'), false);
    assert.equal(testIdpActive(e, `${STAGING}/account/login`), true);
    // The production Worker's own workers.dev and version-preview hosts, and any other host, are refused too.
    assert.equal(testIdpActive(e, 'https://opendrone-web.sales-ee0.workers.dev/account/login'), false);
    assert.equal(testIdpActive(e, 'https://abc12345-opendrone-web.sales-ee0.workers.dev/x'), false);
    assert.equal(testIdpActive(e, 'https://opendrone-web-preview.sales-ee0.workers.dev.evil.example/x'), false);
    assert.equal(testIdpActive(e, 'https://evil-opendrone-web-preview.example/x'), false);
    assert.equal(testIdpActive(e, 'https://opendrone-web-preview.sales-ee0.workers.dev/x'), true);
    assert.equal(testIdpActive({...e, ACCOUNTS_TEST_IDP: '0'}, `${STAGING}/x`), false);
    assert.equal(testIdpActive({...e, ACCOUNTS_ENABLED: '0'}, `${STAGING}/x`), false);
    // On opendrone.be the provider is Shopify (null here: not configured), never the test form.
    assert.equal(identityProvider(e, new Request('https://opendrone.be/account/login')), null);
  });

  it('wrangler.production.toml never sets ACCOUNTS_TEST_IDP and turns ACCOUNTS_ENABLED on', () => {
    const toml = readFileSync(new URL('../../../wrangler.production.toml', import.meta.url), 'utf8');
    const active = toml.split('\n').filter((l) => !l.trim().startsWith('#'));
    assert.ok(!active.some((l) => /ACCOUNTS_TEST_IDP/.test(l)));
    assert.ok(active.some((l) => /^ACCOUNTS_ENABLED\s*=\s*"1"\s*$/.test(l.trim())));
  });
});

describe('pairwise sub', () => {
  it('is stable, shaped acct_<32 hex> and differs from the GID and per salt', async () => {
    const a = await pairwiseSub('salt', GID);
    assert.equal(a, await pairwiseSub('salt', GID));
    assert.match(a, /^acct_[0-9a-f]{32}$/);
    assert.notEqual(a, GID);
    assert.ok(!a.includes('test-1'));
    assert.notEqual(a, await pairwiseSub('salt', 'gid://shopify/Customer/test-2'));
    assert.notEqual(a, await pairwiseSub('other-salt', GID));
  });
});

describe('widget assertion', () => {
  it('has the contract format, aud and a 5 minute exp', async () => {
    const now = 1_800_000_000;
    const {assertion, exp} = await signAssertion('k', 'acct_0123456789abcdef0123456789abcdef', now);
    const [v, payload, mac] = assertion.split('.');
    assert.equal(v, 'v1');
    assert.equal(mac, await hmacB64url('k', `v1.${payload}`));
    const claims = JSON.parse(textFromB64url(payload)) as Record<string, unknown>;
    assert.deepEqual(claims, {sub: 'acct_0123456789abcdef0123456789abcdef', aud: ASSERTION_AUD, iat: now, exp: now + ASSERTION_TTL_SEC});
    assert.equal(exp, now + 300);
  });

  it('endpoint: 204 signed out, 200 signed in, 403 cross-site', async () => {
    const e = await env();
    const url = 'https://opendrone.be/api/account/widget-assertion';
    assert.equal((await widgetAssertion(new Request(url), e)).status, 204);
    const {cookie} = await signedIn(e);
    const ok = await widgetAssertion(new Request(url, {headers: {Cookie: cookie, 'Sec-Fetch-Site': 'same-origin'}}), e);
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as {assertion: string};
    assert.equal((JSON.parse(textFromB64url(body.assertion.split('.')[1])) as {sub: string}).sub, await pairwiseSub('pairwise-salt', GID));
    assert.equal((await widgetAssertion(new Request(url, {headers: {Cookie: cookie, 'Sec-Fetch-Site': 'cross-site'}}), e)).status, 403);
  });

  it('client posts with the exact ChatFPV origin and refreshes before exp', () => {
    const sent: unknown[][] = [];
    const target = {postMessage: (...args: unknown[]) => sent.push(args)} as unknown as Window;
    assert.ok(postAssertion(target, 'https://chatfpv.com/embed?mode=opendrone#cfh=x', 'v1.a.b'));
    assert.deepEqual(sent[0], [{type: 'chatfpv:assertion', assertion: 'v1.a.b'}, 'https://chatfpv.com']);
    assert.equal(frameOrigin('javascript:alert(1)'), null);
    assert.equal(postAssertion(target, 'not a url', 'v1.a.b'), false);
    assert.equal(refreshDelayMs(1000 + 300, 1000 * 1000), 240_000);
  });
});

describe('logout', () => {
  it('oauth/logout allowlists post_logout_redirect_uri, revokes and calls ChatFPV back-channel', async () => {
    const e = await env();
    const {cookie} = await signedIn(e);
    const bad = await oauthLogout(new Request('https://opendrone.be/oauth/logout?post_logout_redirect_uri=https%3A%2F%2Fevil.example%2F', {headers: {Cookie: cookie}}), e, null);
    assert.equal(bad.status, 400);
    const calls: {url: string; body: string; key: string | null}[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({url, body: String(init.body), key: new Headers(init.headers).get('X-ChatFPV-Key')});
      return new Response('{}', {status: 200});
    }) as unknown as typeof fetch;
    const withChatFpv = {...e, CHATFPV_URL: 'https://chatfpv.com', CHATFPV_KEY: 'store-key', CHATFPV: {fetch: fetcher}};
    const ok = await oauthLogout(new Request('https://opendrone.be/oauth/logout?post_logout_redirect_uri=https%3A%2F%2Fchatfpv.com%2F&state=z', {headers: {Cookie: cookie}}), withChatFpv, null);
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('Location'), 'https://chatfpv.com/?state=z');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chatfpv.com/v1/auth/backchannel-logout');
    assert.equal(calls[0].key, 'store-key');
    assert.ok((JSON.parse(calls[0].body) as {sid?: string}).sid);
    assert.equal(await readSession(e.SUPPORT_DB, new Request('https://opendrone.be/', {headers: {Cookie: cookie}})), null);
  });

  it('back-channel needs the store key', async () => {
    assert.equal(await chatFpvBackchannelLogout({CHATFPV_URL: 'https://chatfpv.com'}, 'sid'), false);
  });
});

describe('shopify provider', () => {
  const discovery = {
    issuer: 'https://shopify.com/authentication/123',
    authorization_endpoint: 'https://shopify.com/authentication/123/oauth/authorize',
    token_endpoint: 'https://shopify.com/authentication/123/oauth/token',
    end_session_endpoint: 'https://shopify.com/authentication/123/logout',
  };
  const jwt = (claims: Record<string, unknown>) => `${b64url(new TextEncoder().encode('{"alg":"none"}'))}.${b64url(new TextEncoder().encode(JSON.stringify(claims)))}.sig`;

  it('uses discovery, PKCE S256, nonce, basic auth, and drops access/refresh tokens', async () => {
    let tokenCall: RequestInit | undefined;
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/.well-known/openid-configuration')) return Response.json(discovery);
      tokenCall = init;
      return Response.json({
        access_token: 'AT',
        refresh_token: 'RT',
        id_token: jwt({iss: discovery.issuer, aud: 'cid', exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n', sub: '42'}),
      });
    }) as unknown as typeof fetch;
    const e: AccountsEnv = {SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID: 'cid', SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET: 'cs', SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID: '123'};
    const idp = shopifyIdentityProvider(e, 'https://opendrone.be', fetcher)!;
    const auth = new URL(await idp.authorizeUrl({state: 's', nonce: 'n', codeChallenge: 'c'.repeat(43), redirectUri: 'https://opendrone.be/account/callback'}));
    assert.equal(auth.origin + auth.pathname, discovery.authorization_endpoint);
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('scope'), 'openid email');
    const out = await idp.exchangeCode({code: 'c', codeVerifier: 'v', redirectUri: 'https://opendrone.be/account/callback', nonce: 'n'});
    assert.equal(out.subject, 'gid://shopify/Customer/42');
    assert.ok(!JSON.stringify(out).includes('AT') && !JSON.stringify(out).includes('RT'));
    assert.equal(new Headers(tokenCall?.headers).get('Authorization'), `Basic ${btoa('cid:cs')}`);
    await assert.rejects(idp.exchangeCode({code: 'c', codeVerifier: 'v', redirectUri: 'https://opendrone.be/account/callback', nonce: 'other'}), /nonce/);
    const logout = new URL((await idp.logoutUrl({idTokenHint: 'tok', postLogoutRedirectUri: 'https://opendrone.be/oauth/logout'}))!);
    assert.equal(logout.searchParams.get('id_token_hint'), 'tok');
  });

  it('signs in as a public client (Hydrogen channel) without a client secret', async () => {
    let tokenCall: RequestInit | undefined;
    let discoveryCall: RequestInit | undefined;
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (url.endsWith('/.well-known/openid-configuration')) {
        discoveryCall = init;
        return Response.json(discovery);
      }
      tokenCall = init;
      return Response.json({id_token: jwt({iss: discovery.issuer, aud: 'cid', exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n', sub: '42'})});
    }) as unknown as typeof fetch;
    // Its own shop id: discovery is cached per issuer across tests.
    const e: AccountsEnv = {SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID: 'cid', SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID: '124'};
    const idp = shopifyIdentityProvider(e, 'https://opendrone.be', fetcher)!;
    assert.ok(idp);
    const out = await idp.exchangeCode({code: 'c', codeVerifier: 'v', redirectUri: 'https://opendrone.be/account/callback', nonce: 'n'});
    assert.equal(out.subject, 'gid://shopify/Customer/42');
    const h = new Headers(tokenCall?.headers);
    assert.equal(h.get('Authorization'), null);
    assert.equal(h.get('Origin'), 'https://opendrone.be');
    const body = new URLSearchParams(String(tokenCall?.body));
    assert.equal(body.get('client_id'), 'cid');
    assert.equal(body.get('code_verifier'), 'v');
    // Shopify answers 403 to a Worker discovery fetch without these.
    const dh = new Headers(discoveryCall?.headers);
    assert.equal(dh.get('Origin'), 'https://opendrone.be');
    assert.equal(dh.get('User-Agent'), 'opendrone-web');
    assert.equal(shopifyIdentityProvider({SHOPIFY_CUSTOMER_ACCOUNT_SHOP_ID: '123'}, 'https://opendrone.be', fetcher), null);
  });

  it('normalises the customer GID', () => {
    assert.equal(customerGid('42'), 'gid://shopify/Customer/42');
    assert.equal(customerGid('gid://shopify/Customer/42'), 'gid://shopify/Customer/42');
    assert.equal(customerGid('gid://shopify/Order/42'), null);
  });
});

describe('crypto and headers', () => {
  it('seals the id_token with AES-GCM', async () => {
    const sealed = await seal('k', 'id-token');
    assert.ok(!sealed.includes('id-token'));
    assert.equal(await unseal('k', sealed), 'id-token');
    assert.equal(await unseal('other', sealed), null);
  });

  it('account responses are never framed or cached', () => {
    const h = accountHeaders();
    assert.equal(h.get('Content-Security-Policy'), "frame-ancestors 'none'");
    assert.equal(h.get('X-Frame-Options'), 'DENY');
    assert.equal(h.get('Cache-Control'), 'no-store');
  });
});

describe('Ask box', () => {
  it('sends X-ChatFPV-Account only with the store key and a well-formed sub', async () => {
    const {createChatFpvClient} = await import('../support/chatfpv.ts');
    const seen: Headers[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers));
      return Response.json({answer: 'a', citations: [], outcome: 'answered', confidence: 0.9});
    }) as unknown as typeof fetch;
    const sub = 'acct_0123456789abcdef0123456789abcdef';
    await createChatFpvClient({CHATFPV_URL: 'https://chatfpv.com', CHATFPV_KEY: 'k'}, fetcher).ask('how do I bind?', {accountSub: sub});
    await createChatFpvClient({CHATFPV_URL: 'https://chatfpv.com'}, fetcher).ask('how do I bind?', {accountSub: sub});
    await createChatFpvClient({CHATFPV_URL: 'https://chatfpv.com', CHATFPV_KEY: 'k'}, fetcher).ask('how do I bind?', {accountSub: 'gid://shopify/Customer/1'});
    assert.equal(seen[0].get('X-ChatFPV-Account'), sub);
    assert.equal(seen[1].get('X-ChatFPV-Account'), null);
    assert.equal(seen[2].get('X-ChatFPV-Account'), null);
  });
});
