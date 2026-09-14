import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {preorderNote} from './preorder.ts';
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

describe("Odoo's ship promise", () => {
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
