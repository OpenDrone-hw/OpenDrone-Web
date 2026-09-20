import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {inspectShippingInvoice, sendShippingInvoice} from './shopify-shipping-invoice.ts';

const ENV = {
  SHOPIFY_STORE_DOMAIN: 'open-drone-test.myshopify.com',
  SHOPIFY_ADMIN_API_TOKEN: 'secret',
  SHOPIFY_ADMIN_API_VERSION: '2026-07',
} as const;
const INPUT = {orderId: 'gid://shopify/Order/123', amount: '12.34', service: 'Standard tracked', reference: 'PACK-123'};
const json = (data: unknown) => new Response(JSON.stringify({data}), {headers: {'Content-Type': 'application/json'}});
const order = {id: INPUT.orderId, name: '#1001', currencyCode: 'EUR', cancelledAt: null, displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', shippingLines: {nodes: [{title: 'Shipping billed when ready'}]}};

describe('Shopify shipping invoice', () => {
  it('previews without mutating and does not expose customer data', async () => {
    let calls = 0;
    const result = await inspectShippingInvoice(ENV, INPUT, async () => { calls += 1; return json({order}); });
    assert.equal(calls, 1);
    assert.deepEqual(result, {orderId: INPUT.orderId, orderName: '#1001', amount: '12.34', currency: 'EUR', label: 'OpenDrone shipping: Standard tracked [PACK-123]'});
  });

  it('rejects duplicate references before any order edit', async () => {
    await assert.rejects(inspectShippingInvoice(ENV, INPUT, async () => json({order: {...order, shippingLines: {nodes: [{title: 'OpenDrone shipping: Express [PACK-123]'}]}}})), /already exists/);
  });

  it('requires the independent write gate', async () => {
    let called = false;
    await assert.rejects(sendShippingInvoice(ENV, INPUT, async () => { called = true; return json({}); }), /not enabled/);
    assert.equal(called, false);
  });

  it('adds shipping and commits with customer notification only after preflight', async () => {
    const bodies: Array<{query: string; variables: Record<string, unknown>}> = [];
    const responses = [
      {order},
      {orderEditBegin: {calculatedOrder: {id: 'gid://shopify/CalculatedOrder/9'}, userErrors: []}},
      {orderEditAddShippingLine: {calculatedOrder: {id: 'gid://shopify/CalculatedOrder/9'}, calculatedShippingLine: {id: 'line', title: 'x'}, userErrors: []}},
      {orderEditCommit: {order: {id: INPUT.orderId, name: '#1001'}, userErrors: []}},
    ];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as typeof bodies[number]);
      return json(responses.shift());
    };
    const result = await sendShippingInvoice({...ENV, SHOPIFY_SHIPPING_INVOICE_WRITE_ENABLED: '1'}, INPUT, fetcher);
    assert.equal(result.sent, true);
    assert.equal(bodies.length, 4);
    assert.deepEqual(bodies[2].variables, {id: 'gid://shopify/CalculatedOrder/9', shippingLine: {title: 'OpenDrone shipping: Standard tracked [PACK-123]', price: {amount: '12.34', currencyCode: 'EUR'}}});
    assert.equal(bodies[3].variables.notifyCustomer, true);
  });
});
