import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {permalinkLines} from './cart-permalink.ts';

const catalog = {
  products: [
    {variants: [{merchandise_id: 'app-v1', alias: 'gid://shopify/ProductVariant/111'}, {merchandise_id: 'app-v2', alias: 'gid://shopify/ProductVariant/222', availability: 'sold_out'}]},
    {variants: [{merchandise_id: 'gid://shopify/ProductVariant/333'}]},
  ],
};

describe('cart permalinks', () => {
  it('adds the variants an old Shopify link names, by app id or by the Shopify id it came from', () => {
    assert.deepEqual(permalinkLines('111:2,333:1', catalog), [{variant: 'app-v1', qty: 2}, {variant: 'gid://shopify/ProductVariant/333', qty: 1}]);
    assert.deepEqual(permalinkLines('app-v1', catalog), [{variant: 'app-v1', qty: 1}]);
  });

  it('skips unknown, sold-out and malformed parts', () => {
    assert.deepEqual(permalinkLines('999:1,222:1,111:0,111:x,111:51,:3', catalog), []);
    assert.deepEqual(permalinkLines('', catalog), []);
  });
});
