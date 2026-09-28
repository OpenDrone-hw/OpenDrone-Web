import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {opsAlertOnce} from '../ops-alerts.ts';
import {testD1} from '../support/testing.ts';
import {complianceWebhooksActive, handleComplianceWebhook, payloadCustomerGid, runRightsQueue, type ComplianceEnv, type ComplianceTopic} from './compliance.ts';
import {randomToken} from './crypto.ts';
import {ACCOUNT_IDLE_MS, createSession, purgeExpired, upsertAccount} from './sessions.ts';

const SECRET = 'shopify-webhook-secret';
const ORIGIN = 'https://opendrone.be';
const DAY = 24 * 60 * 60 * 1000;

async function env(extra: Partial<ComplianceEnv> = {}): Promise<ComplianceEnv> {
  const db = await testD1();
  assert.ok(db, 'node:sqlite required');
  return {
    ACCOUNTS_ENABLED: '0',
    SESSION_SECRET: 'session-secret',
    ACCOUNT_PAIRWISE_SALT: 'pairwise-salt',
    CHATFPV_URL: 'https://chatfpv.example',
    CHATFPV_KEY: 'store-key',
    SHOPIFY_WEBHOOK_SECRET: SECRET,
    SUPPORT_DB: db,
    ...extra,
  };
}

type Call = {url: string; method: string; body: string};

function chatfpv(status = 200, body: unknown = {ok: true}): {fetcher: typeof fetch; calls: Call[]} {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({url: String(input), method: init?.method ?? 'GET', body: String(init?.body ?? '')});
    return new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});
  }) as typeof fetch;
  return {fetcher, calls};
}

/** Records alert posts instead of calling Discord. */
function poster(): {post: (channel: string, text: string) => Promise<void>; posts: string[]} {
  const posts: string[] = [];
  return {post: async (_c, text) => void posts.push(text), posts};
}

async function hmacB64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function webhook(topic: ComplianceTopic, customerId: number | null, opts: {secret?: string; hookId?: string} = {}): Promise<Request> {
  const payload =
    topic === 'shop/redact'
      ? {shop_id: 1, shop_domain: 'opendrone.myshopify.com'}
      : topic === 'customers/delete'
        ? {id: customerId, email: 'x@example.com'}
        : {shop_id: 1, shop_domain: 'opendrone.myshopify.com', customer: {id: customerId, email: 'x@example.com'}, orders_to_redact: []};
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Shopify-Topic': topic,
    'X-Shopify-Hmac-Sha256': await hmacB64(opts.secret ?? SECRET, body),
  };
  if (opts.hookId) headers['X-Shopify-Webhook-Id'] = opts.hookId;
  return new Request(`${ORIGIN}/webhooks/shopify/${topic.replace('/', '-').replace('_', '-')}`, {method: 'POST', headers, body});
}

async function customer(e: ComplianceEnv, id: number, now = Date.now()): Promise<string> {
  const db = e.SUPPORT_DB!;
  const accountId = await upsertAccount(db, `gid://shopify/Customer/${id}`, now);
  const {sid} = await createSession(db, e, accountId, '', now);
  await db
    .prepare('INSERT INTO oauth_codes (code_hash, client_id, account_id, sid, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(randomToken(16), 'chatfpv', accountId, sid, 'https://chatfpv.com/auth/callback', 'x', now + 60_000)
    .run();
  return accountId;
}

async function rowCounts(e: ComplianceEnv, accountId: string): Promise<number[]> {
  const db = e.SUPPORT_DB!;
  const n = async (sql: string) => (await db.prepare(sql).bind(accountId).first<{n: number}>())!.n;
  return [
    await n('SELECT COUNT(*) AS n FROM od_accounts WHERE id = ?'),
    await n('SELECT COUNT(*) AS n FROM od_sessions WHERE account_id = ?'),
    await n('SELECT COUNT(*) AS n FROM oauth_codes WHERE account_id = ?'),
  ];
}

type Row = {id: string; kind: string; source: string; status: string; shopify_gid: string | null; attempts: number; export_json: string | null};
const requests = async (e: ComplianceEnv) =>
  ((await e.SUPPORT_DB!.prepare('SELECT * FROM rights_requests ORDER BY received_at, id').all<Row>()).results ?? []) as Row[];

describe('Shopify compliance webhooks', () => {
  it('are live whenever the secret is set, with ACCOUNTS_ENABLED off', async () => {
    const e = await env({ACCOUNTS_ENABLED: '0'});
    assert.equal(complianceWebhooksActive(e), true);
    const a = await customer(e, 101);
    const {fetcher, calls} = chatfpv();
    const res = await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101), e, {fetcher});
    assert.equal(res.status, 200);
    assert.deepEqual(await rowCounts(e, a), [0, 0, 0]);
    assert.equal(calls.length, 1);
  });

  it('answer 404 without the secret and 401 on a wrong or missing signature, touching nothing', async () => {
    const off = await env({SHOPIFY_WEBHOOK_SECRET: undefined});
    assert.equal(complianceWebhooksActive(off), false);
    assert.equal((await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101), off)).status, 404);
    const e = await env();
    const a = await customer(e, 101);
    const {fetcher, calls} = chatfpv();
    const wrong = await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101, {secret: 'wrong'}), e, {fetcher});
    assert.equal(wrong.status, 401);
    const bare = await webhook('customers/redact', 101);
    bare.headers.delete('X-Shopify-Hmac-Sha256');
    assert.equal((await handleComplianceWebhook('customers/redact', bare, e, {fetcher})).status, 401);
    assert.equal(calls.length, 0);
    assert.deepEqual(await rowCounts(e, a), [1, 1, 1]);
    assert.equal((await requests(e)).length, 0);
  });

  it('redact removes only that customer, erases ChatFPV by pairwise sub and records the request', async () => {
    const e = await env();
    const target = await customer(e, 101);
    const other = await customer(e, 202);
    const {fetcher, calls} = chatfpv();
    const res = await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101, {hookId: 'abc-1'}), e, {fetcher});
    assert.equal(res.status, 200);
    assert.deepEqual(await rowCounts(e, target), [0, 0, 0]);
    assert.deepEqual(await rowCounts(e, other), [1, 1, 1]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://chatfpv.example/v1/account/erase');
    assert.match((JSON.parse(calls[0].body) as {sub: string}).sub, /^acct_[0-9a-f]{32}$/);
    assert.ok(!calls[0].body.includes('Customer'), 'no Shopify id leaves opendrone.be');
    const [row] = await requests(e);
    assert.deepEqual([row.id, row.kind, row.source, row.status], ['wh_abc-1', 'erase', 'customers/redact', 'done']);
  });

  it('customers/delete is the same erase, reading the top-level customer id', async () => {
    const e = await env();
    const a = await customer(e, 101);
    const {fetcher, calls} = chatfpv();
    const res = await handleComplianceWebhook('customers/delete', await webhook('customers/delete', 101), e, {fetcher});
    assert.equal(res.status, 200);
    assert.deepEqual(await rowCounts(e, a), [0, 0, 0]);
    assert.equal(calls.length, 1);
    assert.equal((await requests(e))[0].source, 'customers/delete');
  });

  it('a customer who never signed in costs no ChatFPV call', async () => {
    const e = await env();
    const {fetcher, calls} = chatfpv();
    await handleComplianceWebhook('customers/delete', await webhook('customers/delete', 999), e, {fetcher});
    assert.equal(calls.length, 0);
    assert.equal((await requests(e))[0].status, 'done');
  });

  it('a failed ChatFPV erase answers 200, queues a retry and alerts once', async () => {
    const e = await env({OPS_ALERTS_ENABLED: '1', DISCORD_STAFF_METADATA_CHANNEL_ID: '42'});
    await customer(e, 101);
    const {post, posts} = poster();
    const res = await handleComplianceWebhook('customers/redact', await webhook('customers/redact', 101), e, {fetcher: chatfpv(500).fetcher, post});
    assert.equal(res.status, 200);
    const [row] = await requests(e);
    assert.deepEqual([row.kind, row.status, row.attempts], ['erase', 'pending', 1]);
    assert.equal(posts.length, 1);
    assert.ok(!posts[0].includes('Customer'), 'alert carries no customer id');
    // The queue retries until ChatFPV answers, calling it even though the local rows are gone.
    const {fetcher, calls} = chatfpv();
    const report = await runRightsQueue(e, {fetcher, post});
    assert.deepEqual(report.done, [row.id]);
    assert.equal(calls.length, 1);
    assert.equal((await requests(e))[0].status, 'done');
  });

  it('data_request is recorded, then the queue stores the export for the CLI', async () => {
    const e = await env({OPS_ALERTS_ENABLED: '1', DISCORD_STAFF_METADATA_CHANNEL_ID: '42'});
    await customer(e, 101);
    await customer(e, 202);
    const res = await handleComplianceWebhook('customers/data_request', await webhook('customers/data_request', 101), e, {fetcher: chatfpv().fetcher});
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {received: true}, 'no personal data in the response Shopify discards');
    const {fetcher, calls} = chatfpv(200, {conversations: [{id: 'c1'}]});
    const {post, posts} = poster();
    const report = await runRightsQueue(e, {fetcher, post});
    assert.equal(report.ready.length, 1);
    assert.match(calls[0].url, /\/v1\/account\/export\?sub=acct_[0-9a-f]{32}$/);
    const [row] = await requests(e);
    assert.equal(row.status, 'ready');
    const file = JSON.parse(row.export_json!) as {shopify_customer: string; opendrone: {sessions: unknown[]}; chatfpv: unknown};
    assert.equal(file.shopify_customer, 'gid://shopify/Customer/101');
    assert.equal(file.opendrone.sessions.length, 1);
    assert.deepEqual(file.chatfpv, {conversations: [{id: 'c1'}]});
    assert.ok(!row.export_json!.includes('Customer/202'));
    assert.equal(posts.length, 1);
    assert.match(posts[0], /1 export\(s\) ready/);
  });

  it('shop/redact is recorded and deletes nothing', async () => {
    const e = await env();
    const a = await customer(e, 101);
    const res = await handleComplianceWebhook('shop/redact', await webhook('shop/redact', null), e);
    assert.equal(res.status, 200);
    assert.deepEqual(await rowCounts(e, a), [1, 1, 1]);
    const [row] = await requests(e);
    assert.deepEqual([row.kind, row.status, row.shopify_gid], ['shop_redact', 'done', null]);
  });

  it('a redelivery with the same webhook id records one row', async () => {
    const e = await env();
    for (let i = 0; i < 2; i++) {
      await handleComplianceWebhook('customers/data_request', await webhook('customers/data_request', 101, {hookId: 'same'}), e);
    }
    assert.equal((await requests(e)).length, 1);
  });

  it('reads the customer id only when it is a Shopify numeric id', () => {
    assert.equal(payloadCustomerGid({customer: {id: 207119551}}), 'gid://shopify/Customer/207119551');
    assert.equal(payloadCustomerGid({id: 207119551}, true), 'gid://shopify/Customer/207119551');
    assert.equal(payloadCustomerGid({id: 207119551}), null);
    assert.equal(payloadCustomerGid({customer: {id: '1 OR 1=1'}}), null);
    assert.equal(payloadCustomerGid({}), null);
  });
});

describe('ops alerts', () => {
  it('post only where OPS_ALERTS_ENABLED is "1" (production)', async () => {
    const {post, posts} = poster();
    const preview = await env({DISCORD_STAFF_METADATA_CHANNEL_ID: '42'});
    assert.equal(await opsAlertOnce(preview, 'k', 'text', Date.now(), post), false);
    const prod = await env({OPS_ALERTS_ENABLED: '1', DISCORD_STAFF_METADATA_CHANNEL_ID: '42'});
    assert.equal(await opsAlertOnce(prod, 'k', 'text', Date.now(), post), true);
    assert.equal(posts.length, 1);
  });

  it('post at most once per UTC day per key, durably in D1', async () => {
    const e = await env({OPS_ALERTS_ENABLED: '1', DISCORD_STAFF_METADATA_CHANNEL_ID: '42'});
    const {post, posts} = poster();
    const day1 = Date.UTC(2026, 8, 28, 1);
    assert.equal(await opsAlertOnce(e, 'k', 'a', day1, post), true);
    assert.equal(await opsAlertOnce(e, 'k', 'b', day1 + 20 * 60 * 60 * 1000, post), false);
    assert.equal(await opsAlertOnce(e, 'other', 'c', day1, post), true);
    assert.equal(await opsAlertOnce(e, 'k', 'd', day1 + DAY, post), true);
    assert.equal(posts.length, 3);
    const n = await e.SUPPORT_DB!.prepare('SELECT COUNT(*) AS n FROM ops_alerts').first<{n: number}>();
    assert.equal(n!.n, 3);
  });
});

describe('account retention', () => {
  it('purges an account 3 years after its last sign-in unless a session is live', async () => {
    const e = await env();
    const now = Date.now();
    const idle = await customer(e, 101, now - ACCOUNT_IDLE_MS - 40 * DAY);
    const recent = await customer(e, 202, now - 100 * DAY);
    const old = now - ACCOUNT_IDLE_MS - DAY;
    const active = await customer(e, 303, old);
    // A sliding session keeps 303 signed in without a new sign-in.
    await e.SUPPORT_DB!.prepare('UPDATE od_sessions SET expires_at = ? WHERE account_id = ?').bind(now + 10 * DAY, active).run();
    await purgeExpired(e.SUPPORT_DB!, now);
    assert.deepEqual(await rowCounts(e, idle), [0, 0, 0]);
    assert.equal((await rowCounts(e, recent))[0], 1);
    assert.deepEqual((await rowCounts(e, active)).slice(0, 2), [1, 1]);
  });
});
