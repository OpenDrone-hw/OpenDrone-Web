import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {appAccountsEnabled, orderStatus, readAccount, requestLink, sessionCookie, verifyLink, verifyUrl, type AccountEnv} from './app-account.ts';

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
