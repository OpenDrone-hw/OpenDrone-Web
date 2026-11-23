import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {delaysStockParcel} from './stock-parcel.ts';

const STOCK = 'in stock in Belgium, ships to EU addresses in a few working days';
const MARCH = 'ships by 31 March 2027';

describe('delaysStockParcel', () => {
  it('a March item next to a stock-only cart holds the parcel', () => {
    assert.equal(delaysStockParcel([STOCK], MARCH), true);
    assert.equal(delaysStockParcel([STOCK, null], MARCH), true);
  });
  it('a stock item, an empty cart or a cart already waiting for March does not', () => {
    assert.equal(delaysStockParcel([STOCK], STOCK), false);
    assert.equal(delaysStockParcel([], MARCH), false);
    assert.equal(delaysStockParcel([STOCK, MARCH], MARCH), false);
    assert.equal(delaysStockParcel([STOCK], null), false);
  });
});
