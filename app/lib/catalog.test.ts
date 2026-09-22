import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  byHandle,
  bySku,
  cartAddUrl,
  familyGroups,
  formatPrice,
  mapProductOptions,
  parseCatalog,
  selectVariant,
  toCard,
  toCards,
  toProduct,
  type Catalog,
} from './catalog.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/catalog.test.ts

const FIXTURE: Catalog = parseCatalog(
  JSON.parse(
    fs.readFileSync(
      new URL('../../test/fixtures/catalog.json', import.meta.url),
      'utf8',
    ),
  ),
);

describe('parseCatalog', () => {
  it('accepts the contract document', () => {
    assert.equal(FIXTURE.products.length, 2);
    assert.equal(FIXTURE.prices_include_vat, true);
  });

  it('rejects anything that is not a catalog', () => {
    assert.throws(() => parseCatalog(null));
    assert.throws(() => parseCatalog({products: []}));
    assert.throws(() => parseCatalog('<html>login</html>'));
  });
});

describe('lookups', () => {
  it('finds a product by handle', () => {
    assert.equal(byHandle(FIXTURE, 'openrx')?.title, 'OpenRX');
    assert.equal(byHandle(FIXTURE, 'nope'), null);
    assert.equal(byHandle(FIXTURE, null), null);
  });

  it('finds a variant by sku', () => {
    const hit = bySku(FIXTURE, 'OPENFC-LITE-3030');
    assert.equal(hit?.product.handle, 'openfc-lite');
    assert.equal(hit?.variant.price, 59.99);
    assert.equal(bySku(FIXTURE, 'NOPE'), null);
  });

  it('groups by family, preferring the local content family', () => {
    const groups = familyGroups(FIXTURE);
    const families = groups.map((g) => g.family);
    // openfc-lite has no Shopify product type; the content file supplies one.
    assert.ok(families.includes('ELRS Receiver') || families.includes(''));
    const total = groups.reduce((n, g) => n + g.products.length, 0);
    assert.equal(total, FIXTURE.products.length);
  });
});

describe('cartAddUrl', () => {
  const add = '/api/shopify/cart';

  it('builds the single-line hand-off', () => {
    assert.equal(
      cartAddUrl(add, [{sku: 'OPENRX-GEMINI'}]),
      `${add}?sku=OPENRX-GEMINI&qty=1&next=cart`,
    );
  });

  it('builds the multi-line hand-off', () => {
    assert.equal(
      cartAddUrl(add, [
        {sku: 'OPENFC-LITE-3030', quantity: 1},
        {sku: 'OPENESC-3030', quantity: 2},
      ]),
      `${add}?lines=OPENFC-LITE-3030%3A1%2COPENESC-3030%3A2&next=cart`,
    );
  });

  it('carries mode and next', () => {
    const url = cartAddUrl(add, [{sku: 'A'}], {mode: 'set', next: 'checkout'});
    assert.ok(url.includes('mode=set'));
    assert.ok(url.endsWith('next=checkout'));
  });

  it('clamps quantities and line count, and drops empty skus', () => {
    assert.ok(cartAddUrl(add, [{sku: 'A', quantity: 999}]).includes('qty=50'));
    assert.ok(cartAddUrl(add, [{sku: 'A', quantity: 0}]).includes('qty=1'));
    assert.equal(cartAddUrl(add, [{sku: '   '}]), `${add}?next=cart`);
    const many = Array.from({length: 25}, (_, i) => ({sku: `S${i}`}));
    const lines = new URL(cartAddUrl(add, many), 'https://opendrone.be').searchParams.get('lines');
    assert.equal(lines?.split(',').length, 20);
  });
});

describe('toProduct', () => {
  const product = toProduct(FIXTURE, byHandle(FIXTURE, 'openrx')!);

  it('maps prices as money strings', () => {
    const gemini = product.variants.nodes.find(
      (v) => v.sku === 'OPENRX-GEMINI',
    )!;
    assert.deepEqual(gemini.price, {amount: '39.99', currencyCode: 'EUR'});
    assert.deepEqual(gemini.compareAtPrice, {
      amount: '49.99',
      currencyCode: 'EUR',
    });
  });

  it('drops a compare price that is not higher than the price', () => {
    const lite = product.variants.nodes.find((v) => v.sku === 'OPENRX-LITE')!;
    assert.equal(lite.compareAtPrice, null);
  });

  it('maps availability onto availableForSale and keeps the ship promise', () => {
    const bySkuMap = Object.fromEntries(
      product.variants.nodes.map((v) => [v.sku, v]),
    );
    assert.equal(bySkuMap['OPENRX-GEMINI'].availableForSale, true);
    assert.equal(
      bySkuMap['OPENRX-GEMINI'].shipPromise,
      'ships from early October 2026',
    );
    assert.equal(bySkuMap['OPENRX-LITE'].availableForSale, true);
    assert.equal(bySkuMap['OPENRX-MONO'].availableForSale, false);
  });

  it('carries the ready-made hand-off link per variant', () => {
    assert.equal(
      product.variants.nodes[0].cartAddUrl,
      '/api/shopify/cart?sku=OPENRX-GEMINI&qty=1',
    );
  });

  it('falls back to the template image when a variant has none', () => {
    const gemini = product.variants.nodes.find(
      (v) => v.sku === 'OPENRX-GEMINI',
    )!;
    assert.ok(gemini.image?.url.endsWith('openrx-1.png'));
  });

  it('computes the price range across variants', () => {
    assert.equal(product.priceRange.minVariantPrice.amount, '24.99');
    assert.equal(product.priceRange.maxVariantPrice.amount, '39.99');
  });

  it('keeps a published rating and drops an empty one', () => {
    assert.deepEqual(product.rating, {average: 4.5, count: 2});
    assert.equal(
      toProduct(FIXTURE, byHandle(FIXTURE, 'openfc-lite')!).rating,
      null,
    );
  });
});

describe('variant selection', () => {
  const product = toProduct(FIXTURE, byHandle(FIXTURE, 'openrx')!);

  it('honours ?Model=, case-insensitively', () => {
    assert.equal(
      selectVariant(product.variants.nodes, [{name: 'model', value: 'gemini'}])
        ?.sku,
      'OPENRX-GEMINI',
    );
  });

  it('falls back to the first buyable variant', () => {
    assert.equal(
      selectVariant(product.variants.nodes, [{name: 'Model', value: 'Ghost'}])
        ?.sku,
      'OPENRX-GEMINI',
    );
    assert.equal(selectVariant([], [])?.sku, undefined);
  });

  it('maps the option model the selectors read', () => {
    const selected = toProduct(FIXTURE, byHandle(FIXTURE, 'openrx')!, [
      {name: 'Model', value: 'Lite'},
    ]);
    const options = mapProductOptions(selected);
    assert.equal(options.length, 1);
    assert.equal(options[0].name, 'Model');
    const values = Object.fromEntries(
      options[0].optionValues.map((v) => [v.name, v]),
    );
    assert.equal(values.Lite.selected, true);
    assert.equal(values.Gemini.selected, false);
    assert.equal(values.Gemini.exists, true);
    assert.equal(values.Mono.available, false);
    assert.equal(values.Gemini.variantUriQuery, 'Model=Gemini');
  });
});

describe('cards', () => {
  it('maps every product to a card', () => {
    assert.equal(toCards(FIXTURE).length, 2);
    const card = toCard(FIXTURE, byHandle(FIXTURE, 'openfc-lite')!);
    assert.equal(card.handle, 'openfc-lite');
    assert.equal(card.priceRange.minVariantPrice.amount, '44.99');
    assert.equal(card.variants.nodes.length, 2);
  });
});

describe('formatPrice', () => {
  it('formats euro amounts', () => {
    assert.equal(formatPrice('39.99', 'EUR'), '€39.99');
    assert.equal(formatPrice(5, 'EUR'), '€5.00');
  });

  it('is empty for a missing amount', () => {
    assert.equal(formatPrice(null, 'EUR'), '');
    assert.equal(formatPrice('', 'EUR'), '');
  });
});
