import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {appAccountsEnabled, codeAction, invoiceRoute, orderStatus, readAccount, reorderRoute, requestLink, sessionCookie, verifyCode, verifyLink, verifyUrl, type AccountEnv} from './app-account.ts';

const ENV: AccountEnv = {
  COMMERCE_SOURCE: 'app',
  APP_API_URL: 'https://app.example',
  APP_STOREFRONT_TOKEN: 'b',
  SESSION_SECRET: 'secret',
  ACCOUNTS_ENABLED: '1',
};
const json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});

describe('app accounts', () => {
  it('need the app source and ACCOUNTS_ENABLED exactly 1', () => {
    assert.equal(appAccountsEnabled(ENV), true);
    assert.equal(appAccountsEnabled({...ENV, ACCOUNTS_ENABLED: '0'}), false);
    assert.equal(appAccountsEnabled({ACCOUNTS_ENABLED: '1'}), false);
  });

  it('read the account with the session of the signed cookie, and flag a stale one', async () => {
    const calls: Array<{url: string; body: Record<string, unknown>}> = [];
    const cookie = (await sessionCookie(ENV).serialize('s'.repeat(43))).split(';')[0];
    const reply = (body: unknown) => (async (url: string, init: RequestInit) => {
      calls.push({url, body: JSON.parse(String(init.body)) as Record<string, unknown>});
      return json(body);
    }) as unknown as typeof fetch;
    const req = new Request('https://shop.example/account', {headers: {Cookie: cookie}});
    const ok = await readAccount(req, ENV, reply({ok: true, data: {email: 'a@b.co', orders: [], addresses: [], since: ''}}));
    assert.equal(ok.account?.email, 'a@b.co');
    assert.equal(calls[0].url, 'https://app.example/api/ops/storefront.account');
    assert.equal(calls[0].body.session, 's'.repeat(43));
    const stale = await readAccount(req, ENV, reply({ok: false, error: {code: 'unauthenticated', detail: ''}}));
    assert.deepEqual([stale.account, stale.clear], [null, true]);
    const none = await readAccount(new Request('https://shop.example/account'), ENV, reply({}));
    assert.deepEqual([none.account, none.clear, calls.length], [null, false, 2]);
  });

  it('name the verify page with a safe return path, and report an app that is down', async () => {
    const req = new Request('https://shop.example/account/login');
    assert.equal(verifyUrl(req, '/shop/cart'), 'https://shop.example/account/verify?return_to=%2Fshop%2Fcart');
    assert.equal(verifyUrl(req, '//evil.example'), 'https://shop.example/account/verify?return_to=%2F');
    const down = (async () => { throw new Error('x'); }) as unknown as typeof fetch;
    assert.equal(await requestLink(ENV, {email: 'a@b.co'}, 'https://shop.example/account/verify', down), false);
    assert.equal(await verifyLink(ENV, 't'.repeat(40), (async () => json({ok: false})) as unknown as typeof fetch), null);
  });

  it('say one status word per order', () => {
    const base = {state: {payment: 'paid', fulfilment: 'unfulfilled'}, canceled: false};
    assert.equal(orderStatus(base), 'Paid');
    assert.equal(orderStatus({...base, shipment: {tracking_number: 'Z1'}}), 'Shipped');
    assert.equal(orderStatus({...base, payment_mode: 'none'}), 'Test order, not paid');
    assert.equal(orderStatus({...base, canceled: true}), 'Canceled');
  });
});

describe('app account sign-in by code', () => {
  const cookieOf = async (token: string) => (await sessionCookie(ENV).serialize(token)).split(';')[0];
  const post = (body: Record<string, string>) =>
    new Request('https://shop.example/account/login', {method: 'POST', headers: {Origin: 'https://shop.example'}, body: new URLSearchParams(body)});

  it('verifyCode sends the address and the code, and answers null for any refusal', async () => {
    const seen: Array<{url: string; body: Record<string, unknown>}> = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({url, body: JSON.parse(String(init.body)) as Record<string, unknown>});
      return json({ok: false, error: {code: 'invalid_code', detail: 'x'}});
    }) as unknown as typeof fetch;
    assert.equal(await verifyCode(ENV, 'a@b.co', '123456', f), null);
    assert.equal(seen[0].url, 'https://app.example/api/ops/storefront.account_verify_code');
    assert.equal(seen[0].body.email, 'a@b.co');
    assert.equal(seen[0].body.code, '123456');
    const ok = (async () => json({ok: true, data: {session: 's'.repeat(43)}})) as unknown as typeof fetch;
    assert.equal(await verifyCode(ENV, 'a@b.co', '123456', ok), 's'.repeat(43));
  });

  it('codeAction refuses a bad shape and a foreign origin before calling the app', async () => {
    const short = await codeAction(post({email: 'a@b.co', code: '12345'}), ENV);
    assert.ok(!(short instanceof Response) && /6 digits/.test(short.problem ?? ''));
    const foreign = await codeAction(new Request('https://shop.example/account/login', {method: 'POST', headers: {Origin: 'https://evil.example'}, body: new URLSearchParams({email: 'a@b.co', code: '123456'})}), ENV);
    assert.ok(!(foreign instanceof Response) && foreign.problem);
  });

  it('invoiceRoute and reorderRoute need a session; reorder skips lines that are gone and merges into the cart', async () => {
    assert.equal((await invoiceRoute(new Request('https://shop.example/account/invoices/T-1'), ENV, 'T-1')).status, 404);
    assert.equal((await invoiceRoute(new Request('https://shop.example/x', {headers: {Cookie: await cookieOf('s'.repeat(43))}}), ENV, '../x')).status, 404);
    const order = {number: 'T-1', state: {payment: 'paid', fulfilment: 'x'}, canceled: false, reorder: {country: 'BE', lines: [
      {variant: 'v1', qty: 2, title: 'A', variant_title: '', available: true, unit_minor: 100},
      {variant: 'v2', qty: 1, title: 'B', variant_title: '', available: false, unit_minor: 100}]}};
    const real = globalThis.fetch;
    globalThis.fetch = (async () => json({ok: true, data: {email: 'a@b.co', since: '', orders: [order], addresses: []}})) as unknown as typeof fetch;
    try {
      const req = new Request('https://shop.example/account/reorder', {method: 'POST', headers: {Origin: 'https://shop.example', Cookie: await cookieOf('s'.repeat(43))}, body: new URLSearchParams({number: 'T-1'})});
      const res = await reorderRoute(req, ENV);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('Location'), '/shop/cart');
      assert.ok(res.headers.get('Set-Cookie')?.startsWith('od_app_cart='));
    } finally {
      globalThis.fetch = real;
    }
  });
});
