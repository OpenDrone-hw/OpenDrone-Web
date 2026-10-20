import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {sessionCookie} from './app-account.ts';
import {appChatFpvSub, appHistory, appWidgetAssertion, chatFpvConnected} from './app-chatfpv.ts';

const ENV = {COMMERCE_SOURCE: 'app', APP_API_URL: 'https://app.example', APP_STOREFRONT_TOKEN: 'b', SESSION_SECRET: 'secret', ACCOUNTS_ENABLED: '1',
  ACCOUNT_PAIRWISE_SALT: 'salt', WIDGET_ASSERTION_KEY: 'key', CHATFPV_KEY: 'k', CHATFPV_URL: 'https://chatfpv.example'} as never as Parameters<typeof appChatFpvSub>[1];
const cookie = async () => (await sessionCookie(ENV).serialize('s'.repeat(43))).split(';')[0];
const account = (id: string) => (async () => new Response(JSON.stringify({ok: true, data: {email: 'a@b.co', customer_id: id, orders: [], addresses: []}}), {headers: {'content-type': 'application/json'}})) as unknown as typeof fetch;
const req = async (path = '/x', init: RequestInit = {}) => new Request('https://shop.example' + path, {...init, headers: {Cookie: await cookie(), ...(init.headers as object)}});

describe('ChatFPV in app mode', () => {
  it('derives one stable account id from the app customer id, and none without an id', async () => {
    const a = await appChatFpvSub(await req(), ENV, account('c'.repeat(32)));
    assert.match(a ?? '', /^acct_[0-9a-f]{32}$/);
    assert.equal(await appChatFpvSub(await req(), ENV, account('c'.repeat(32))), a);
    assert.notEqual(await appChatFpvSub(await req(), ENV, account('d'.repeat(32))), a);
    assert.equal(await appChatFpvSub(await req(), ENV, account('')), null);
  });

  it('signs a widget assertion for the signed-in customer and answers 204 otherwise', async () => {
    const ok = await appWidgetAssertion(await req(), ENV, account('c'.repeat(32)));
    assert.equal(ok.status, 200);
    assert.match(((await ok.json()) as {assertion: string}).assertion, /^v1\./);
    assert.equal((await appWidgetAssertion(new Request('https://shop.example/x'), ENV, account('c'))).status, 204);
    assert.equal((await appWidgetAssertion(await req('/x', {headers: {'Sec-Fetch-Site': 'cross-site'}}), ENV, account('c'))).status, 403);
  });

  it('knows whether ChatFPV is connected', () => {
    assert.equal(chatFpvConnected(ENV), true);
    assert.equal(chatFpvConnected({...ENV, CHATFPV_KEY: ''}), false);
  });

  it('refuses a history request from another origin and one without the delete box ticked', async () => {
    const post = async (body: Record<string, string>, origin: string) => req('/account/chatfpv-history', {method: 'POST', headers: {Origin: origin}, body: new URLSearchParams(body)});
    assert.equal((await appHistory(await post({intent: 'export'}, 'https://evil.example'), ENV)).status, 403);
    assert.equal((await appHistory(await post({intent: 'nope'}, 'https://shop.example'), ENV)).status, 400);
  });
});
