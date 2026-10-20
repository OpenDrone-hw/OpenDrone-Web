import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {sessionCookie, type AccountEnv} from './app-account.ts';
import {erasureRoute, preferencesRoute, problemOf, profileRoute} from './app-account-manage.ts';

const ENV: AccountEnv = {COMMERCE_SOURCE: 'app', APP_API_URL: 'https://app.example', APP_STOREFRONT_TOKEN: 'b', SESSION_SECRET: 'secret', ACCOUNTS_ENABLED: '1'};
const TOKEN = 's'.repeat(43);

async function post(body: Record<string, string>, origin = 'https://shop.example', signedIn = true) {
  const cookie = signedIn ? (await sessionCookie(ENV).serialize(TOKEN)).split(';')[0] : '';
  return new Request('https://shop.example/account/profile', {method: 'POST', headers: {Origin: origin, Cookie: cookie}, body: new URLSearchParams(body)});
}
function app(reply: unknown) {
  const calls: Array<{url: string; body: Record<string, unknown>}> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({url, body: JSON.parse(String(init.body)) as Record<string, unknown>});
    return new Response(JSON.stringify(reply), {headers: {'content-type': 'application/json'}});
  }) as unknown as typeof fetch;
  return {calls, fetcher};
}
// profileRoute calls the global fetch through appOp: swap it for one test at a time.
async function withApp<T>(reply: unknown, run: () => Promise<T>) {
  const real = globalThis.fetch;
  const a = app(reply);
  globalThis.fetch = a.fetcher;
  try {
    return {out: await run(), calls: a.calls};
  } finally {
    globalThis.fetch = real;
  }
}

describe('My account profile', () => {
  it('saves the name with the session of the cookie', async () => {
    const {out, calls} = await withApp({ok: true, data: {}}, async () => profileRoute(await post({intent: 'name', name: ' Bo '}), ENV));
    assert.deepEqual([out.ok, out.problem], [true, null]);
    assert.equal(calls[0].url, 'https://app.example/api/ops/storefront.account_profile');
    assert.deepEqual([calls[0].body.session, calls[0].body.name], [TOKEN, 'Bo']);
  });

  it('refuses a cross-origin post, a signed-out one and a name that is too long before the app is called', async () => {
    const {out, calls} = await withApp({ok: true}, async () => [
      await profileRoute(await post({intent: 'name', name: 'x'}, 'https://evil.example'), ENV),
      await profileRoute(await post({intent: 'name', name: 'x'}, 'https://shop.example', false), ENV),
      await profileRoute(await post({intent: 'name', name: 'x'.repeat(121)}), ENV),
    ]);
    assert.deepEqual(out.map((r) => r.ok), [false, false, false]);
    assert.equal(calls.length, 0);
  });

  it('asks for the code first, then spends it, and stays on the code step when it fails', async () => {
    const start = await withApp({ok: true, data: {sent: true}}, async () => profileRoute(await post({intent: 'email', new_email: 'New@Example.com'}), ENV));
    assert.deepEqual([start.out.ok, start.out.step, start.out.email], [true, 'code', 'new@example.com']);
    assert.equal('code' in start.calls[0].body, false);
    const bad = await withApp({ok: false, error: {code: 'invalid_code', detail: 'x'}}, async () => profileRoute(await post({intent: 'email-confirm', new_email: 'new@example.com', code: '123 456'}), ENV));
    assert.deepEqual([bad.out.ok, bad.out.step, bad.calls[0].body.code], [false, 'code', '123456']);
    assert.match(bad.out.problem ?? '', /did not work/);
    const done = await withApp({ok: true, data: {email: 'new@example.com'}}, async () => profileRoute(await post({intent: 'email-confirm', new_email: 'new@example.com', code: '123456'}), ENV));
    assert.deepEqual([done.out.ok, done.out.step], [true, 'idle']);
  });

  it('checks the address and the digits before the app is called, and says an address with an account is taken', async () => {
    const {out, calls} = await withApp({ok: false, error: {code: 'taken', detail: ''}}, async () => [
      await profileRoute(await post({intent: 'email', new_email: 'nonsense'}), ENV),
      await profileRoute(await post({intent: 'email-confirm', new_email: 'a@b.co', code: '12'}), ENV),
      await profileRoute(await post({intent: 'email-confirm', new_email: 'a@b.co', code: '123456'}), ENV),
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(out.map((r) => r.step), ['idle', 'code', 'idle']);
    assert.match(out[2].problem ?? '', /already has its own account/);
  });

  it('turns an unreachable app into one sentence', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    try {
      const out = await profileRoute(await post({intent: 'name', name: 'Bo'}), ENV);
      assert.match(out.problem ?? '', /cannot be reached/);
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(problemOf({ok: true}, 'x'), null);
  });
});

describe('My account preferences and the delete request', () => {
  it('records the marketing answer through the app and refuses anything but yes or no', async () => {
    const {out, calls} = await withApp({ok: true, data: {}}, async () => [
      await preferencesRoute(await post({intent: 'marketing', marketing: 'yes'}), ENV),
      await preferencesRoute(await post({intent: 'marketing', marketing: 'maybe'}), ENV),
    ]);
    assert.deepEqual(out.map((r) => r.ok), [true, false]);
    assert.equal(calls.length, 1);
    assert.deepEqual([calls[0].url, calls[0].body.marketing], ['https://app.example/api/ops/storefront.account_profile', true]);
  });

  it('sends the delete request only with the box ticked, and only when signed in from the same origin', async () => {
    const {out, calls} = await withApp({ok: true, data: {requested_at: 'x'}}, async () => [
      await erasureRoute(await post({intent: 'erasure'}), ENV),
      await erasureRoute(await post({intent: 'erasure', confirm: 'yes'}, 'https://evil.example'), ENV),
      await erasureRoute(await post({intent: 'erasure', confirm: 'yes'}, 'https://shop.example', false), ENV),
      await erasureRoute(await post({intent: 'erasure', confirm: 'yes'}), ENV),
    ]);
    assert.deepEqual(out.map((r) => r.ok), [false, false, false, true]);
    assert.deepEqual(calls.map((c) => c.url), ['https://app.example/api/ops/storefront.account_erasure']);
  });
});
