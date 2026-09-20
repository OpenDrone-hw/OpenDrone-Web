import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {requestedLines} from './shopify-cart-input.ts';

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

describe('Shopify cart input', () => {
  it('aggregates duplicate SKUs without imposing a campaign quantity cap', () => {
    assert.deepEqual(requestedLines(form({lines: 'OPENRX-LITE:2,OPENRX-LITE:3'})), [
      {sku: 'OPENRX-LITE', quantity: 5},
    ]);
    assert.deepEqual(requestedLines(form({sku: 'OPENRX-LITE', qty: '10000'})), [
      {sku: 'OPENRX-LITE', quantity: 10000},
    ]);
  });

  for (const [name, values] of [
    ['negative', {sku: 'OPENRX-LITE', qty: '-1'}],
    ['decimal', {sku: 'OPENRX-LITE', qty: '1.5'}],
    ['infinite', {sku: 'OPENRX-LITE', qty: 'Infinity'}],
    ['malformed', {sku: 'not valid', qty: '1'}],
    ['extra separators', {lines: 'OPENRX-LITE:1:2'}],
    ['mixed formats', {lines: 'OPENRX-LITE:1', sku: 'OPENRX-LITE'}],
  ] as const) {
    it(`rejects ${name} input`, () => {
      assert.throws(() => requestedLines(form(values)), (error: unknown) => {
        assert.ok(error instanceof Response);
        assert.equal(error.status, 400);
        return true;
      });
    });
  }

  it('rejects rather than truncating more than twenty lines', () => {
    const lines = Array.from({length: 21}, (_, i) => `SKU-${i}:1`).join(',');
    assert.throws(() => requestedLines(form({lines})), (error: unknown) => {
      assert.ok(error instanceof Response);
      assert.equal(error.status, 400);
      return true;
    });
  });

  it('rejects repeated and empty cart control fields', () => {
    const repeated = new FormData();
    repeated.append('sku', 'OPENRX-LITE');
    repeated.append('sku', 'OPENRX-GEMINI');
    assert.throws(() => requestedLines(repeated), (error: unknown) => {
      assert.ok(error instanceof Response);
      assert.equal(error.status, 400);
      return true;
    });
    assert.throws(() => requestedLines(form({lines: ''})), (error: unknown) => {
      assert.ok(error instanceof Response);
      assert.equal(error.status, 400);
      return true;
    });
  });
});
