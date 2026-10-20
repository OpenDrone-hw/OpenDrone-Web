import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {describe, it} from 'node:test';
import {handlePayWebhook, MAX_BODY_BYTES, paypalOrderId, safeEqual, verifyStripe, type PayHookEnv} from './pay-webhook.ts';

const ENV: PayHookEnv = {
  COMMERCE_SOURCE: 'app',
  APP_API_URL: 'https://app.example',
  APP_STOREFRONT_TOKEN: 'b',
  APP_PROJECT: 'p',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  PAYPAL_WEBHOOK_ID_LIVE: 'WH-1',
  PAYPAL_CLIENT_ID_LIVE: 'cid',
  PAYPAL_CLIENT_SECRET_LIVE: 'sec',
};
const NOW = 1_800_000_000_000;

function relay(ok = true) {
  const calls: Array<{url: string; body: string}> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({url: String(url), body: String(init?.body ?? '')});
    if (String(url).endsWith('/oauth2/token')) return Response.json({access_token: 'tok'});
    if (String(url).endsWith('/verify-webhook-signature')) return Response.json({verification_status: ok ? 'SUCCESS' : 'FAILURE'});
    return Response.json({ok: true, data: {ok: true}});
  }) as typeof fetch;
  return {calls, fetcher};
}
const hooks = (calls: Array<{url: string; body: string}>) => calls.filter((c) => c.url.endsWith('/api/ops/storefront.payment_hook'));
const post = (body: string, headers: Record<string, string> = {}) => new Request('https://shop.example/x', {method: 'POST', body, headers});

function stripeHeader(body: string, ts = NOW / 1000, secret = 'whsec_test') {
  return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
}
const stripeEvent = (type: string, id = 'cs_test_1') => JSON.stringify({type, data: {object: {id}}});

describe('pay webhook', () => {
  it('is 404 outside app mode and for other providers, and nothing is relayed', async () => {
    const {calls, fetcher} = relay();
    assert.equal((await handlePayWebhook(post('id=tr_1'), 'mollie', {}, fetcher)).status, 404);
    assert.equal((await handlePayWebhook(post('id=tr_1'), 'mollie', {...ENV, COMMERCE_SOURCE: 'shopify'}, fetcher)).status, 404);
    assert.equal((await handlePayWebhook(post('id=tr_1'), 'adyen', ENV, fetcher)).status, 404);
    assert.equal(calls.length, 0);
  });

  it('mollie relays only the id', async () => {
    const {calls, fetcher} = relay();
    const res = await handlePayWebhook(post('id=tr_abc123&amount=9&status=paid'), 'mollie', ENV, fetcher);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(hooks(calls).length, 1);
    assert.deepEqual(JSON.parse(hooks(calls)[0].body), {project: 'p', provider: 'mollie', id: 'tr_abc123'});
    assert.equal((await handlePayWebhook(post('id=evil'), 'mollie', ENV, fetcher)).status, 400);
    assert.equal((await handlePayWebhook(post(''), 'mollie', ENV, fetcher)).status, 400);
  });

  it('limits the body', async () => {
    const {calls, fetcher} = relay();
    const res = await handlePayWebhook(post('id=tr_1&x=' + 'a'.repeat(MAX_BODY_BYTES)), 'mollie', ENV, fetcher);
    assert.equal(res.status, 413);
    assert.equal(calls.length, 0);
  });

  it('stripe checks the signature, the tolerance and the event type', async () => {
    const body = stripeEvent('checkout.session.completed');
    const good = {'stripe-signature': stripeHeader(body)};
    const {calls, fetcher} = relay();
    assert.equal((await handlePayWebhook(post(body, good), 'stripe', ENV, fetcher, NOW)).status, 200);
    assert.deepEqual(JSON.parse(hooks(calls)[0].body), {project: 'p', provider: 'stripe', id: 'cs_test_1'});
    assert.equal((await handlePayWebhook(post(body, {'stripe-signature': stripeHeader(body, NOW / 1000, 'other')}), 'stripe', ENV, fetcher, NOW)).status, 400);
    assert.equal((await handlePayWebhook(post(body), 'stripe', ENV, fetcher, NOW)).status, 400);
    assert.equal((await handlePayWebhook(post(body, {'stripe-signature': stripeHeader(body, NOW / 1000 - 600)}), 'stripe', ENV, fetcher, NOW)).status, 400);
    assert.equal((await handlePayWebhook(post(body, good), 'stripe', {...ENV, STRIPE_WEBHOOK_SECRET: ''}, fetcher, NOW)).status, 400);
    const other = stripeEvent('charge.refunded', 'ch_1');
    assert.equal((await handlePayWebhook(post(other, {'stripe-signature': stripeHeader(other)}), 'stripe', ENV, fetcher, NOW)).status, 200);
    assert.equal(hooks(calls).length, 1);
  });

  it('verifyStripe accepts a rotated second v1 and rejects a tampered body', async () => {
    const h = stripeHeader('{}');
    assert.equal(await verifyStripe(`${h},v1=00`, '{}', 'whsec_test', NOW), true);
    assert.equal(await verifyStripe(h, '{"a":1}', 'whsec_test', NOW), false);
    assert.equal(safeEqual('ab', 'ab'), true);
    assert.equal(safeEqual('ab', 'abc'), false);
  });

  const ppHeaders = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.paypal.com/cert',
    'paypal-transmission-id': 't1',
    'paypal-transmission-sig': 's',
    'paypal-transmission-time': '2026-10-20T10:00:00Z',
  };
  it('paypal verifies through the API and relays the order id', async () => {
    const approved = JSON.stringify({event_type: 'CHECKOUT.ORDER.APPROVED', resource: {id: 'ORD123'}});
    const {calls, fetcher} = relay();
    assert.equal((await handlePayWebhook(post(approved, ppHeaders), 'paypal', ENV, fetcher)).status, 200);
    assert.deepEqual(JSON.parse(hooks(calls)[0].body), {project: 'p', provider: 'paypal', id: 'ORD123'});
    const verify = calls.find((c) => c.url === 'https://api-m.paypal.com/v1/notifications/verify-webhook-signature');
    assert.equal((JSON.parse(verify!.body) as {webhook_id: string}).webhook_id, 'WH-1');
    const cap = JSON.stringify({event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {id: 'CAP1', supplementary_data: {related_ids: {order_id: 'ORD9'}}}});
    assert.equal(paypalOrderId(JSON.parse(cap) as Parameters<typeof paypalOrderId>[0]), 'ORD9');
  });

  it('paypal rejects a failed or impossible verification', async () => {
    const body = JSON.stringify({event_type: 'CHECKOUT.ORDER.APPROVED', resource: {id: 'ORD123'}});
    const bad = relay(false);
    assert.equal((await handlePayWebhook(post(body, ppHeaders), 'paypal', ENV, bad.fetcher)).status, 400);
    assert.equal(hooks(bad.calls).length, 0);
    const none = relay();
    assert.equal((await handlePayWebhook(post(body, ppHeaders), 'paypal', {...ENV, PAYPAL_WEBHOOK_ID_LIVE: ''}, none.fetcher)).status, 400);
    assert.equal((await handlePayWebhook(post(body), 'paypal', ENV, none.fetcher)).status, 400);
    assert.equal(hooks(none.calls).length, 0);
  });

  it('answers 503 when the app is unreachable and 502 when it refuses', async () => {
    const down = (async () => { throw new Error('x'); }) as typeof fetch;
    assert.equal((await handlePayWebhook(post('id=tr_1'), 'mollie', ENV, down)).status, 503);
    const no = (async () => Response.json({ok: false, error: {code: 'x', detail: 'y'}})) as typeof fetch;
    assert.equal((await handlePayWebhook(post('id=tr_1'), 'mollie', ENV, no)).status, 502);
  });
});
