import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  PREORDER_ATTR_KEY,
  preorderNote,
  stampPreorderLines,
} from './preorder.ts';
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

/** The shape the cart action hands over: CartLineInput, structurally. */
type Line = {
  merchandiseId?: string;
  quantity: number;
  attributes?: Array<{key: string; value: string}> | null;
};

describe('stampPreorderLines', () => {
  const notes = new Map([
    ['gid://shopify/ProductVariant/1', 'ships from early October 2026'],
  ]);

  it('stamps only the mapped merchandise ids', () => {
    const lines: Line[] = [
      {merchandiseId: 'gid://shopify/ProductVariant/1', quantity: 1},
      {merchandiseId: 'gid://shopify/ProductVariant/2', quantity: 2},
    ];
    const out = stampPreorderLines(lines, notes);
    assert.deepEqual(out[0].attributes, [
      {key: PREORDER_ATTR_KEY, value: 'ships from early October 2026'},
    ]);
    assert.deepEqual(out[1].attributes, []);
    // The rest of the line is untouched.
    assert.equal(out[1].quantity, 2);
  });

  it('strips a client-supplied Pre-order attribute and keeps the others', () => {
    const lines: Line[] = [
      {
        merchandiseId: 'gid://shopify/ProductVariant/2',
        quantity: 1,
        attributes: [
          {key: PREORDER_ATTR_KEY, value: 'ships tomorrow, promise'},
          {key: 'Vote', value: 'openvtx'},
        ],
      },
      {
        merchandiseId: 'gid://shopify/ProductVariant/1',
        quantity: 1,
        attributes: [{key: PREORDER_ATTR_KEY, value: 'forged'}],
      },
    ];
    const out = stampPreorderLines(lines, notes);
    assert.deepEqual(out[0].attributes, [{key: 'Vote', value: 'openvtx'}]);
    assert.deepEqual(out[1].attributes, [
      {key: PREORDER_ATTR_KEY, value: 'ships from early October 2026'},
    ]);
  });

  it('leaves lines without a merchandise id alone', () => {
    const lines: Line[] = [{quantity: 1, attributes: null}];
    const out = stampPreorderLines(lines, notes);
    assert.deepEqual(out[0].attributes, []);
  });
});
