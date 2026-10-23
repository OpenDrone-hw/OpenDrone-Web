import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {confirmWithApp, subscribeWithApp, unsubscribeWithApp} from './app-newsletter.ts';
import type {AppEnv} from './app-api.ts';

const ENV: AppEnv = {COMMERCE_SOURCE: 'app', APP_API_URL: 'https://app.example', APP_STOREFRONT_TOKEN: 'b', SESSION_SECRET: 's'};
function app(reply: unknown, status = 200) {
  const calls: Array<{url: string; body: Record<string, unknown>}> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({url, body: JSON.parse(String(init.body)) as Record<string, unknown>});
    return new Response(JSON.stringify(reply), {status, headers: {'content-type': 'application/json'}});
  }) as unknown as typeof fetch;
  return {calls, fetcher};
}
const ok = (result: string) => ({ok: true, data: {result, unsubscribe_token: null}});

describe('app newsletter', () => {
  it('maps the app answers to the Shopify path answers', async () => {
    for (const [result, want] of [['subscribed', 'subscribed'], ['already_subscribed', 'already-subscribed'], ['suppressed', 'suppressed'], ['pending', 'pending'], ['other', 'failed']]) {
      const a = app(ok(result));
      assert.equal(await subscribeWithApp(ENV, 'pilot@example.com', undefined, null, a.fetcher), want);
      assert.equal(a.calls[0].url, 'https://app.example/api/ops/storefront.newsletter_subscribe');
    }
  });

  it('sends the product handle, and the country only when it is not sold direct', async () => {
    const us = app(ok('subscribed'));
    await subscribeWithApp(ENV, 'a@example.com', 'openrx', 'US', us.fetcher);
    assert.deepEqual([us.calls[0].body.product, us.calls[0].body.country, us.calls[0].body.source], ['openrx', 'US', 'site']);
    const be = app(ok('subscribed'));
    await subscribeWithApp(ENV, 'a@example.com', undefined, 'BE', be.fetcher);
    assert.equal('country' in be.calls[0].body, false);
    assert.equal('product' in be.calls[0].body, false);
  });

  it('fails, never fakes a signup, when the app refuses or does not answer', async () => {
    assert.equal(await subscribeWithApp(ENV, 'a@example.com', undefined, null, app({ok: false, error: {code: 'not_enabled', detail: ''}}).fetcher), 'failed');
    const down = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    assert.equal(await subscribeWithApp(ENV, 'a@example.com', undefined, null, down), 'failed');
    assert.equal(await unsubscribeWithApp(ENV, 'a@example.com', down), 'failed');
  });

  it('unsubscribes by address and fails on a refusal', async () => {
    const a = app(ok('unsubscribed'));
    assert.equal(await unsubscribeWithApp(ENV, 'a@example.com', a.fetcher), 'unsubscribed');
    assert.deepEqual(a.calls[0].body.email, 'a@example.com');
    assert.equal(await unsubscribeWithApp(ENV, 'a@example.com', app({ok: false, error: {code: 'not_enabled', detail: ''}}).fetcher), 'failed');
  });
});

describe('app newsletter double opt-in', () => {
  it('sends the confirm link base only when asked', async () => {
    const a = app(ok('pending'));
    await subscribeWithApp(ENV, 'a@example.com', undefined, null, a.fetcher, 'https://shop.example/newsletter/confirm');
    assert.equal(a.calls[0].body.link_base, 'https://shop.example/newsletter/confirm');
    const b = app(ok('subscribed'));
    await subscribeWithApp(ENV, 'a@example.com', undefined, null, b.fetcher);
    assert.equal('link_base' in b.calls[0].body, false);
  });

  it('maps the confirm answers and never fakes a confirmation', async () => {
    const a = app(ok('confirmed'));
    assert.equal(await confirmWithApp(ENV, 'sub-1.x', a.fetcher), 'confirmed');
    assert.equal(a.calls[0].url, 'https://app.example/api/ops/storefront.newsletter_confirm');
    assert.equal(a.calls[0].body.token, 'sub-1.x');
    assert.equal(await confirmWithApp(ENV, 't', app(ok('already_confirmed')).fetcher), 'already-confirmed');
    assert.equal(await confirmWithApp(ENV, 't', app({ok: false, error: {code: 'invalid_token', detail: ''}}).fetcher), 'invalid');
    assert.equal(await confirmWithApp(ENV, 't', app({ok: false, error: {code: 'expired', detail: ''}}).fetcher), 'expired');
    assert.equal(await confirmWithApp(ENV, 't', app({ok: false, error: {code: 'not_enabled', detail: ''}}).fetcher), 'failed');
    const down = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    assert.equal(await confirmWithApp(ENV, 't', down), 'failed');
  });
});
