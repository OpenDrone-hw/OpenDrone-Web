import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {AccountOrder} from './customer-shopify.ts';
import {formatOrderDate, formatOrderMoney, orderItems, orderStatus} from './order-display.ts';

function order(partial: Partial<AccountOrder> = {}): AccountOrder {
  return {
    id: 'o1',
    name: '#1001',
    createdAt: '2026-09-29T09:00:00Z',
    statusPageUrl: null,
    lines: [{sku: 'A', name: 'OpenFC Lite', variant: '30×30', quantity: 1}],
    total: {amount: '89.00', currencyCode: 'EUR'},
    fulfillmentStatus: 'UNFULFILLED',
    financialStatus: 'PAID',
    cancelled: false,
    isPreorder: false,
    promise: null,
    ...partial,
  };
}

const TARGET = {kind: 'target' as const, day: '2027-03-31', text: 'ships by 31 Mar 2027', delivered: null};
const DATED = {kind: 'date' as const, day: '2026-11-10', text: 'ships early Nov 2026', delivered: '30 Nov 2026'};

describe('orderStatus', () => {
  it('is Processing for a plain paid, unfulfilled order', () => {
    assert.deepEqual(orderStatus(order()), {tone: 'processing', label: 'Processing', note: null});
  });

  it('shows the latest promise for a preorder, with no extra note', () => {
    const lines = [
      {sku: 'A', name: 'OpenFrame', variant: null, quantity: 1},
      {sku: 'B', name: 'OpenMotor', variant: '2306', quantity: 4},
    ];
    const s = orderStatus(order({isPreorder: true, promise: TARGET, lines}));
    assert.equal(s.tone, 'preorder');
    assert.equal(s.label, 'Preorder, ships by 31 Mar 2027');
    assert.equal(s.note, null);
  });

  it('names no delivery date for a dated preorder, ', () => {
    const s = orderStatus(order({isPreorder: true, promise: DATED}));
    assert.equal(s.label, 'Preorder, ships early Nov 2026');
    assert.equal(s.note, null);
  });

  it('is a bare Preorder when no batch promise is known', () => {
    const s = orderStatus(order({isPreorder: true}));
    assert.equal(s.label, 'Preorder');
    assert.equal(s.note, null);
  });

  it('is Shipped or Partly shipped once fulfilled, even with the preorder tag', () => {
    assert.equal(orderStatus(order({fulfillmentStatus: 'FULFILLED', isPreorder: true, promise: TARGET})).label, 'Shipped');
    assert.equal(orderStatus(order({fulfillmentStatus: 'PARTIALLY_FULFILLED'})).label, 'Partly shipped');
  });

  it('is Refunded or Cancelled ahead of everything else', () => {
    assert.equal(orderStatus(order({financialStatus: 'REFUNDED', fulfillmentStatus: 'FULFILLED'})).label, 'Refunded');
    assert.equal(orderStatus(order({cancelled: true, isPreorder: true, promise: TARGET})).label, 'Cancelled');
    assert.equal(orderStatus(order({financialStatus: 'VOIDED'})).label, 'Cancelled');
  });

  it('notes a partial refund without changing the chip', () => {
    const s = orderStatus(order({financialStatus: 'PARTIALLY_REFUNDED', fulfillmentStatus: 'FULFILLED'}));
    assert.equal(s.label, 'Shipped');
    assert.equal(s.note, 'Partly refunded.');
  });
});

describe('orderItems', () => {
  const lines = Array.from({length: 6}, (_, i) => ({sku: `S${i}`, name: `Item ${i}`, variant: i % 2 ? `V${i}` : null, quantity: i + 1}));

  it('keeps quantity, name and variant apart, never "Name - Variant"', () => {
    const {shown} = orderItems(lines);
    assert.deepEqual(shown[1], {quantity: 2, name: 'Item 1', variant: 'V1'});
    assert.equal(shown[0].variant, null);
  });

  it('collapses beyond four lines to "+N more"', () => {
    const r = orderItems(lines);
    assert.equal(r.shown.length, 4);
    assert.equal(r.more, 2);
  });

  it('shows four lines or fewer in full', () => {
    assert.deepEqual(orderItems(lines.slice(0, 4)).more, 0);
    assert.equal(orderItems([]).shown.length, 0);
  });
});

describe('formatting', () => {
  it('formats money with its currency and tolerates a bad amount or code', () => {
    assert.equal(formatOrderMoney({amount: '612.40', currencyCode: 'EUR'}), '€612.40');
    assert.equal(formatOrderMoney(null), null);
    assert.equal(formatOrderMoney({amount: 'x', currencyCode: 'EUR'}), null);
    assert.equal(formatOrderMoney({amount: '5', currencyCode: 'nope!'}), '5.00 nope!');
  });

  it('formats the date in UTC with the year', () => {
    assert.equal(formatOrderDate('2026-09-29T23:30:00Z'), '29 Sept 2026');
  });
});
