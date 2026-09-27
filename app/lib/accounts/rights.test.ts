import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {testD1} from '../support/testing.ts';
import {pkceChallenge, randomToken} from './crypto.ts';
import {authorize} from './oauth.ts';
import {accountHistory, handleComplianceWebhook, payloadCustomerGid, type RightsEnv} from './rights.ts';
import {createSession, SESSION_COOKIE, upsertAccount} from './sessions.ts';

const WEBHOOK_SECRET = 'shopify-webhook-secret';
const ORIGIN = 'https://opendrone.be';

async function env(extra: Partial<RightsEnv> = {}): Promise<RightsEnv> {
  const db = await testD1();
  assert.ok(db, 'node:sqlite required');
  return {
    ACCOUNTS_ENABLED: '1',
    SESSION_SECRET: 'session-secret',
    ACCOUNT_PAIRWISE_SALT: 'pairwise-salt',
    CHATFPV_URL: 'https://chatfpv.example',
    CHATFPV_KEY: 'store-key',
    SHOPIFY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SUPPORT_DB: db,
    ...extra,
  };
}

type Call = {url: string; method: string; body: string; key: string | null};

/** A ChatFPV stand-in that records every call. */
function chatfpv(status = 200, body: unknown = {ok: true}): {fetcher: typeof fetch; calls: Call[]} {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? ''), key: headers.get('X-ChatFPV-Key')});
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
  }) as typeof fetch;
  return {fetcher, calls};
}

async function hmacB64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function webhook(topic: 'customers/redact' | 'customers/data_request', customerId: number, secret = WEBHOOK_SECRET): Promise<Request> {
  const body = JSON.stringify({shop_id: 1, shop_domain: 'opendrone.myshopify.com', customer: {id: customerId, email: 'x@example.com'}, orders_to_redact: []});
  return new Request(`${ORIGIN}/webhooks/shopify/${topic.replace('/', '-').replace('_', '-')}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Shopify-Hmac-Sha256': await hmacB64(secret, body)},
    body,
  });
}

/** One customer with a session and an OAuth code; returns the Cookie header and account id. */
async function customer(e: RightsEnv, id: number): Promise<{cookie: string; accountId: string}> {
  const db = e.SUPPORT_DB!;
  const accountId = await upsertAccount(db, `gid://shopify/Customer/${id}`);
  const {cookieValue, sid} = await createSession(db, e, accountId, '');
  await db
    .prepare('INSERT INTO oauth_codes (code_hash, client_id, account_id, sid, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(randomToken(16), 'chatfpv', accountId, sid, 'https://chatfpv.com/auth/callback', 'x', Date.now() + 60_000)
    .run();
  return {cookie: `${SESSION_COOKIE}=${cookieValue}`, accountId};
}

async function rowCounts(e: RightsEnv, accountId: string): Promise<number[]> {
  const db = e.SUPPORT_DB!;
  const n = async (sql: string) => (await db.prepare(sql).bind(accountId).first<{n: number}>())!.n;
  return [
    await n('SELECT COUNT(*) AS n FROM od_accounts WHERE id = ?'),
    await n('SELECT COUNT(*) AS n FROM od_sessions WHERE account_id = ?'),
    await n('SELECT COUNT(*) AS n FROM oauth_codes WHERE account_id = ?'),
  ];
}

describe('Shopify compliance webhooks', () => {
  it('refuses a wrong signature and touches nothing', async () => {
    const e = await env();
    const a = await customer(e, 101);
    const {fetcher, calls} = chatfpv();
    const res = await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101, 'wrong-secret'), e, fetcher);
    assert.equal(res.status, 401);
    assert.equal(calls.length, 0);
    assert.deepEqual(await rowCounts(e, a.accountId), [1, 1, 1]);
  });

  it('refuses a missing signature and a missing secret', async () => {
    const e = await env();
    const req = await webhook('customers/redact', 101);
    req.headers.delete('X-Shopify-Hmac-Sha256');
    assert.equal((await handleComplianceWebhook('customers/redact', req, e, chatfpv().fetcher)).status, 401);
    const noSecret = await env({SHOPIFY_WEBHOOK_SECRET: undefined});
    assert.equal((await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101), noSecret, chatfpv().fetcher)).status, 503);
  });

  it('answers 404 while ACCOUNTS_ENABLED is off', async () => {
    const e = await env({ACCOUNTS_ENABLED: '0'});
    const {fetcher, calls} = chatfpv();
    assert.equal((await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101), e, fetcher)).status, 404);
    assert.equal(calls.length, 0);
  });

  it('redact removes only that customer rows and erases ChatFPV once by pairwise sub', async () => {
    const e = await env();
    const target = await customer(e, 101);
    const other = await customer(e, 202);
    const {fetcher, calls} = chatfpv();
    const res = await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101), e, fetcher);
    assert.equal(res.status, 200);
    assert.deepEqual(await rowCounts(e, target.accountId), [0, 0, 0]);
    assert.deepEqual(await rowCounts(e, other.accountId), [1, 1, 1]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chatfpv.example/v1/account/erase');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].key, 'store-key');
    const {sub} = JSON.parse(calls[0].body) as {sub: string};
    assert.match(sub, /^acct_[0-9a-f]{32}$/);
    assert.ok(!calls[0].body.includes('Customer'), 'no Shopify id leaves opendrone.be');
  });

  it('redact answers 502 when ChatFPV fails, so Shopify redelivers', async () => {
    const e = await env();
    await customer(e, 101);
    const res = await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101), e, chatfpv(500).fetcher);
    assert.equal(res.status, 502);
  });

  it('data_request returns that customer export and nobody else', async () => {
    const e = await env();
    await customer(e, 101);
    await customer(e, 202);
    const {fetcher, calls} = chatfpv(200, {conversations: [{id: 'c1'}]});
    const res = await handleComplianceWebhook('customers/data_request', await webhook('customers/data_request', 101), e, fetcher);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {customer: string; opendrone: {sessions: unknown[]}; chatfpv: unknown};
    assert.equal(body.customer, 'gid://shopify/Customer/101');
    assert.equal(body.opendrone.sessions.length, 1);
    assert.deepEqual(body.chatfpv, {conversations: [{id: 'c1'}]});
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/chatfpv\.example\/v1\/account\/export\?sub=acct_[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(body).includes('Customer/202'));
  });

  it('data_request for a customer who never signed in asks ChatFPV nothing', async () => {
    const e = await env();
    const {fetcher, calls} = chatfpv();
    const res = await handleComplianceWebhook('customers/data_request', await webhook('customers/data_request', 303), e, fetcher);
    assert.equal(res.status, 200);
    assert.equal(calls.length, 0);
  });

  it('reads the customer id from the payload only when it is a Shopify numeric id', () => {
    assert.equal(payloadCustomerGid({customer: {id: 207119551}}), 'gid://shopify/Customer/207119551');
    assert.equal(payloadCustomerGid({customer: {id: '1 OR 1=1'}}), null);
    assert.equal(payloadCustomerGid({}), null);
  });
});

describe('/account ChatFPV history', () => {
  const post = (cookie: string, fields: Record<string, string>, origin = ORIGIN) =>
    new Request(`${ORIGIN}/account/chatfpv-history`, {
      method: 'POST',
      headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams(fields).toString(),
    });

  it('refuses a foreign Origin', async () => {
    const e = await env();
    const {cookie} = await customer(e, 101);
    const {fetcher, calls} = chatfpv();
    assert.equal((await accountHistory(post(cookie, {intent: 'delete', confirm: 'yes'}, 'https://evil.example'), e, fetcher)).status, 403);
    assert.equal(calls.length, 0);
  });

  it('exports as a JSON download', async () => {
    const e = await env();
    const {cookie} = await customer(e, 101);
    const res = await accountHistory(post(cookie, {intent: 'export'}), e, chatfpv(200, {conversations: []}).fetcher);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('Content-Disposition') ?? '', /^attachment; filename="chatfpv-history-/);
    assert.deepEqual(await res.json(), {conversations: []});
  });

  it('deletes only with the confirm box, then erases once', async () => {
    const e = await env();
    const {cookie} = await customer(e, 101);
    const {fetcher, calls} = chatfpv();
    const unconfirmed = await accountHistory(post(cookie, {intent: 'delete'}), e, fetcher);
    assert.equal(unconfirmed.headers.get('Location'), '/account?chatfpv=confirm');
    assert.equal(calls.length, 0);
    const res = await accountHistory(post(cookie, {intent: 'delete', confirm: 'yes'}), e, fetcher);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('Location'), '/account?chatfpv=deleted');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/v1/account/erase'));
  });

  it('sends a signed-out browser to sign in', async () => {
    const e = await env();
    const res = await accountHistory(post('', {intent: 'export'}), e, chatfpv().fetcher);
    assert.equal(res.headers.get('Location'), '/account/login?return_to=%2Faccount');
  });
});

describe('silent SSO privacy', () => {
  it('a signed-out prompt=none bounce sets no cookie on opendrone.be', async () => {
    const e = await env({CHATFPV_OAUTH_REDIRECTS: 'https://chatfpv.com/auth/callback'});
    const url = new URL('/oauth/authorize', ORIGIN);
    url.search = new URLSearchParams({
      client_id: 'chatfpv',
      redirect_uri: 'https://chatfpv.com/auth/callback',
      state: 'st',
      code_challenge: await pkceChallenge(randomToken(48)),
      code_challenge_method: 'S256',
      prompt: 'none',
    }).toString();
    const res = await authorize(new Request(url), e);
    assert.equal(res.status, 302);
    assert.equal(new URL(res.headers.get('Location')!).searchParams.get('error'), 'login_required');
    assert.equal(res.headers.get('Set-Cookie'), null);
  });
});
