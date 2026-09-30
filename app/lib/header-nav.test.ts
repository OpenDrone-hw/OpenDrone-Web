import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {BAR_LINKS, SHOP_EXTRAS, SHOP_FAMILIES, isShopPath} from './header-nav.ts';
import {FAMILIES} from './families.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/header-nav.test.ts

const reachable = [
  ...SHOP_FAMILIES.map((f) => f.to),
  ...SHOP_EXTRAS.map((l) => l.to),
  ...BAR_LINKS.map((l) => l.to),
];

describe('header navigation', () => {
  it('reaches every page the old header linked to', () => {
    for (const to of ['/products', '/preorder', '/wholesale', '/newsletter', '/support']) {
      assert.ok(reachable.includes(to), `${to} is not in the header or its Shop panel`);
    }
  });

  it('lists every product family plus Accessories, filtered on the listing', () => {
    assert.deepEqual(
      SHOP_FAMILIES.map((f) => f.type),
      [...FAMILIES.map((f) => f.type), 'Accessory'],
    );
    for (const f of SHOP_FAMILIES) {
      assert.equal(f.to, `/products?type=${encodeURIComponent(f.type)}`);
    }
  });

  it('has no duplicate destinations', () => {
    assert.equal(new Set(reachable).size, reachable.length);
  });

  it('labels the support link Support, not Contact', () => {
    const support = BAR_LINKS.find((l) => l.to === '/support');
    assert.equal(support?.label, 'Support');
    assert.ok(!reachable.includes('/contact'));
  });

  it('folds only Newsletter into the Shop panel on tablets', () => {
    assert.deepEqual(
      BAR_LINKS.filter((l) => l.collapses).map((l) => l.to),
      ['/newsletter'],
    );
  });

  it('marks Shop current on the catalogue, product pages and Wholesale only', () => {
    for (const p of ['/products', '/products/openesc', '/wholesale', '/collections/all']) {
      assert.ok(isShopPath(p), p);
    }
    for (const p of ['/', '/preorder', '/support', '/productsx', '/newsletter']) {
      assert.ok(!isShopPath(p), p);
    }
  });
});
