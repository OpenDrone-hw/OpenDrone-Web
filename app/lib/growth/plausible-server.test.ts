import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {purchaseBody, purchaseEventsEnabled, purchaseFromOrder, sendPurchaseEvent} from './plausible-server.ts';

const ORDER = {
  id: 5550001,
  test: false,
  total_price: '249.00',
  currency: 'EUR',
  note_attributes: [{name: '_ref', value: 'alice'}, {name: '_utm_campaign', value: 'launch'}],
  client_details: {browser_ip: '203.0.113.7', user_agent: 'Mozilla/5.0 Test'},
  shipping_address: {country_code: 'be'},
  line_items: [{sku: 'OPENRX-LITE'}, {sku: 'OPENFC-LITE-2020'}, {sku: 'OPENRX-LITE'}],
};

describe('Plausible purchase event', () => {
  it('reads the order into a bounded event', () => {
    const event = purchaseFromOrder(ORDER);
    assert.deepEqual(event, {
      orderId: '5550001', total: 249, currency: 'EUR', source: 'alice', ref: 'alice', campaign: 'launch',
      country: 'BE', skus: 'OPENFC-LITE-2020+OPENRX-LITE', ip: '203.0.113.7', userAgent: 'Mozilla/5.0 Test',
    });
    assert.deepEqual(purchaseBody(event!), {
      name: 'Purchase',
      domain: 'opendrone.be',
      url: 'https://opendrone.be/purchase',
      // A creator slug is not a canonical source: it folds to `other`, the slug is in `ref`.
      props: {source: 'other', ref: 'alice', campaign: 'launch', country: 'BE', skus: 'OPENFC-LITE-2020+OPENRX-LITE'},
      revenue: {currency: 'EUR', amount: 249},
    });
  });

  it('skips test orders, zero totals and junk', () => {
    assert.equal(purchaseFromOrder({...ORDER, test: true}), null);
    assert.equal(purchaseFromOrder({...ORDER, total_price: '0.00'}), null);
    assert.equal(purchaseFromOrder(null), null);
    assert.equal(purchaseFromOrder({...ORDER, note_attributes: [{name: '_ref', value: '<x>'}]})?.ref, undefined);
  });

  it('forwards the buyer IP and User-Agent, and reports a dropped event as failed', async () => {
    let headers: Record<string, string> = {};
    const ok = await sendPurchaseEvent(purchaseFromOrder(ORDER)!, (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response('ok', {status: 202});
    }) as unknown as typeof fetch);
    assert.equal(ok, true);
    assert.equal(headers['x-forwarded-for'], '203.0.113.7');
    assert.equal(headers['user-agent'], 'Mozilla/5.0 Test');
    const dropped = await sendPurchaseEvent(purchaseFromOrder(ORDER)!, (async () =>
      new Response('ok', {status: 202, headers: {'x-plausible-dropped': '1'}})) as unknown as typeof fetch);
    assert.equal(dropped, false);
    let called = false;
    const noIp = await sendPurchaseEvent({...purchaseFromOrder(ORDER)!, ip: undefined}, (async () => { called = true; return new Response(null, {status: 202}); }) as unknown as typeof fetch);
    assert.equal(noIp, false);
    assert.equal(called, false);
  });

  it('is off unless explicitly enabled', () => {
    assert.equal(purchaseEventsEnabled({}), false);
    assert.equal(purchaseEventsEnabled({PLAUSIBLE_PURCHASE_EVENTS_ENABLED: 'true'}), false);
    assert.equal(purchaseEventsEnabled({PLAUSIBLE_PURCHASE_EVENTS_ENABLED: '1'}), true);
  });
});
