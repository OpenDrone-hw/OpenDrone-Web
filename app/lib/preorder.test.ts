import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {preorderNote, shipPromiseFor} from './preorder.ts';
import {PRODUCT_CONTENT} from './product-content.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/preorder.test.ts

describe('preorderNote', () => {
  it("is the product's own statusNote when the content file carries one", () => {
    assert.equal(preorderNote('openesc'), 'ships from early October 2026');
    assert.equal(preorderNote('openrx'), 'ships in about 10 weeks');
  });

  it('falls back to the shop-wide default for a product without a note', () => {
    PRODUCT_CONTENT['__test-nonote'] = {
      ...PRODUCT_CONTENT.openesc,
      statusNote: undefined,
    };
    try {
      // Without Vite the copy store is empty, so this is the literal fallback,
      // which mirrors product-chrome.preorder_lead_default.
      assert.equal(preorderNote('__test-nonote'), 'ships in about 10 weeks');
      assert.equal(preorderNote('no-such-product'), 'ships in about 10 weeks');
    } finally {
      delete PRODUCT_CONTENT['__test-nonote'];
    }
  });
});

describe("the catalog ship promise", () => {
  it("wins over the content file's note", () => {
    assert.equal(
      preorderNote('openesc', 'ships from mid-October 2026'),
      'ships from mid-October 2026',
    );
  });

  it('falls through when the catalog carries none', () => {
    assert.equal(preorderNote('openesc', null), 'ships from early October 2026');
    assert.equal(preorderNote('openesc', ''), 'ships from early October 2026');
  });
});

describe('shipPromiseFor', () => {
  it('honours a closed SKU whose policy withdrew the promise', () => {
    // SHOPIFY_PREVIEW_POLICY_JSON sets shipPromise: null on every sold_out
    // SKU. `??` used to coalesce that null and republish the content file's
    // dispatch date on a storefront with no checkout.
    assert.equal(shipPromiseFor(null, 'ships from early October 2026'), null);
  });

  it("uses the catalog's word when the variant carries one", () => {
    assert.equal(
      shipPromiseFor('ships from early October 2026', 'ships in about 10 weeks'),
      'ships from early October 2026',
    );
  });

  it('falls back to the content note only when the variant has no opinion', () => {
    assert.equal(
      shipPromiseFor(undefined, 'ships in about 10 weeks'),
      'ships in about 10 weeks',
    );
    assert.equal(shipPromiseFor(undefined, undefined), null);
  });
});
