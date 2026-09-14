import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {FAMILIES} from './families.ts';
import {PRODUCT_CONTENT} from './product-content.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/families.test.ts

describe('FAMILIES', () => {
  const inContent = new Set(
    Object.values(PRODUCT_CONTENT).map((c) => c.family),
  );

  it('every family is a family a product actually declares', () => {
    // A renamed family that only got changed in one place silently empties
    // a header dropdown and a filter-rail entry. Nothing else catches it.
    for (const f of FAMILIES) {
      assert.ok(
        inContent.has(f.type),
        `no content/products/*.json declares family "${f.type}"`,
      );
    }
  });

  it('every family points at a product page that exists', () => {
    for (const f of FAMILIES) {
      const handle = f.to.replace('/products/', '');
      assert.ok(
        PRODUCT_CONTENT[handle],
        `${f.type} points at /products/${handle}, which has no content file`,
      );
      assert.equal(PRODUCT_CONTENT[handle].family, f.type);
    }
  });

  it('has no duplicate types or labels', () => {
    assert.equal(new Set(FAMILIES.map((f) => f.type)).size, FAMILIES.length);
    assert.equal(new Set(FAMILIES.map((f) => f.short)).size, FAMILIES.length);
  });
});
