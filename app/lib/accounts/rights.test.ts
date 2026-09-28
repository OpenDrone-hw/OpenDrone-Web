import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {testD1} from '../support/testing.ts';
import {pkceChallenge, randomToken} from './crypto.ts';
import {authorize} from './oauth.ts';
import {accountHistory, type RightsEnv} from './rights.ts';
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
