import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {
  buildOf,
  buildSuggestionSpecs,
  extraSuggestionSpecs,
  parseBuilds,
  resolveBuild,
  resolveBuildSuggestions,
} from './build-recommendations.ts';
import type {ProductCardFragment, ProductVariantFragment} from './product-shapes.ts';

const BUILDS = parseBuilds(
  JSON.parse(fs.readFileSync(new URL('../../content/builds.json', import.meta.url), 'utf8')),
);

describe('build of a SKU', () => {
  it('reads the size from sized parts only', () => {
    assert.equal(buildOf(BUILDS, 'OPENFC-LITE-2020'), '3-inch');
    assert.equal(buildOf(BUILDS, 'OPENFRAME-5'), '5-inch');
    assert.equal(buildOf(BUILDS, 'OPENMOTOR-1604'), '3-inch');
    assert.equal(buildOf(BUILDS, 'OPENMOTOR-1604-4S'), '3-inch');
    assert.equal(buildOf(BUILDS, 'OPENMOTOR-2306-4S'), '5-inch');
    assert.equal(buildOf(BUILDS, 'OPENRX-GEMINI'), null);
    assert.equal(buildOf(BUILDS, 'OPENRX-MONO'), null);
  });

  it('falls back to a sized part in the cart for a size-neutral add', () => {
    assert.equal(resolveBuild(BUILDS, 'OPENRX-MONO', ['OPENRX-MONO', 'OPENESC-3030']), '5-inch');
    assert.equal(resolveBuild(BUILDS, 'OPENRX-MONO', ['OPENRX-MONO']), null);
    assert.equal(resolveBuild(BUILDS, 'OPENESC-2020', ['OPENFRAME-5']), '3-inch');
  });
});

describe('buildSuggestionSpecs', () => {
  it('treats a sibling motor variant as filling the motor role', () => {
    const specs = buildSuggestionSpecs(BUILDS, '3-inch', [{sku: 'OPENMOTOR-1604', handle: 'openmotor', quantity: 4}]);
    assert.ok(!specs.some((p) => p.role === 'motors'));
  });

  it('suggests four matching motors and a size-appropriate receiver', () => {
    const specs = buildSuggestionSpecs(BUILDS, '3-inch', [{sku: 'OPENFC-LITE-2020', handle: 'openfc-lite'}]);
    assert.deepEqual(
      specs.map(({sku, quantity}) => [sku, quantity]),
      [['OPENESC-2020', 1], ['OPENFRAME-3', 1], ['OPENMOTOR-1604-4S', 4], ['OPENRX-LITE-UFL', 1], ['ACC-PROP-3-HQ-T3X3X3', 4]],
    );
  });

  it('suggests props for the size and no antenna: receivers ship with one', () => {
    const specs = buildSuggestionSpecs(BUILDS, '5-inch', [{sku: 'OPENMOTOR-2306', handle: 'openmotor'}]);
    const props = specs.find((s) => s.role === 'props');
    assert.equal(props?.sku, 'ACC-PROP-5-HQ-5X43X3-V2S');
    assert.equal(props?.handle, 'hqprop-5x4-3x3-v2s-propeller-set-5-inch');
    assert.equal(props?.quantity, 4);
    assert.equal(specs.some((s) => s.role === 'antenna'), false);
    const three = buildSuggestionSpecs(BUILDS, '3-inch', [{sku: 'OPENFRAME-3', handle: 'openframe'}]);
    assert.equal(three.some((s) => s.role === 'antenna'), false);
    assert.equal(buildOf(BUILDS, 'ACC-PROP-3-HQ-T3X3X3'), '3-inch');
  });

  it('matches the final 5-inch CAD receiver', () => {
    const specs = buildSuggestionSpecs(BUILDS, '5-inch', [{sku: 'OPENFC-LITE-3030', handle: 'openfc-lite'}]);
    assert.equal(specs.find((s) => s.role === 'receiver')?.sku, 'OPENRX-MONO');
  });

  it('never suggests a role the cart already fills, whatever its size', () => {
    const cart = [
      {sku: 'OPENESC-2020', handle: 'openesc', variantTitle: '20×20'},
      {sku: 'OPENRX-LITE', handle: 'openrx', variantTitle: 'Lite'},
      {sku: 'OPENFC-LITE-2020', handle: 'openfc-lite', variantTitle: '20×20'},
    ];
    const specs = buildSuggestionSpecs(BUILDS, '5-inch', cart);
    assert.equal(specs.some((s) => ['esc', 'receiver', 'flight-controller'].includes(s.role)), false);
    assert.ok(specs.some((s) => s.role === 'frame'));
  });

  it('lets Shopify rank compatible parts without adding incompatible ones', () => {
    const ranked = buildSuggestionSpecs(
      BUILDS,
      '3-inch',
      [{sku: 'OPENFC-LITE-2020', handle: 'openfc-lite'}],
      ['openrx', 'openmotor', 'elsewhere'],
    );
    assert.deepEqual(ranked.map(({handle}) => handle), [
      'openrx',
      'openmotor',
      'openesc',
      'openframe',
      'hqprop-t3x3x3-propeller-set-3-inch-t-mount',
    ]);
    assert.ok(ranked.every(({sku}) => !sku.endsWith('3030') && !sku.endsWith('2306')));
  });

  it('rejects a build that uses an unknown role', () => {
    assert.throws(
      () => parseBuilds({roles: {}, builds: [{id: 'x', label: 'x', parts: [{role: 'esc', sku: 'A', quantity: 1}]}]}),
      /unknown role/,
    );
  });
});

function card(handle: string, sku: string, availableForSale = true): ProductCardFragment {
  const variant = {sku, availableForSale} as ProductVariantFragment;
  return {handle, variants: {nodes: [variant]}} as ProductCardFragment;
}

describe('resolveBuildSuggestions', () => {
  it('keeps only variants that exist, are for sale and pass the status gate', () => {
    const products = [card('openesc', 'OPENESC-2020'), card('openframe', 'OPENFRAME-3', false), card('openmotor', 'OPENMOTOR-1604')];
    const specs = buildSuggestionSpecs(BUILDS, '3-inch', [{sku: 'OPENFC-LITE-2020', handle: 'openfc-lite'}]);
    const out = resolveBuildSuggestions(products, specs, (handle) => handle !== 'openmotor');
    assert.deepEqual(out.map(({sku}) => sku), ['OPENESC-2020']);
  });
});

describe('extraSuggestionSpecs', () => {
  const skus = (cart: string[], exclude: string[] = []) =>
    extraSuggestionSpecs(BUILDS, cart.map((sku) => ({sku, handle: ''})), exclude).map((e) => e.sku);

  it('offers the spares of the size in the cart only', () => {
    assert.deepEqual(skus(['OPENFRAME-3']), ['ACC-STRAP-15X200', 'ACC-PROP-3-HQ-T3X2X3-DUR', 'ACC-FRM-ARM-3']);
    assert.deepEqual(skus(['OPENESC-3030']), ['ACC-STRAP-20X220']);
  });

  it('offers the spare antenna that matches the receiver', () => {
    assert.deepEqual(skus(['OPENRX-LITE-UFL']), ['ACC-STRAP-20X220', 'ACC-ANT-T']);
    assert.deepEqual(skus(['OPENRX-GEMINI']), ['ACC-STRAP-20X220', 'ACC-ANT-DUAL-T']);
    assert.deepEqual(skus(['OPENRX-LITE']), ['ACC-STRAP-15X200']);
  });

  it('offers one strap per quad, never one per motor', () => {
    const strap = (cart: Array<[string, number]>) =>
      extraSuggestionSpecs(BUILDS, cart.map(([sku, quantity]) => ({sku, handle: '', quantity}))).find((e) =>
        e.sku.startsWith('ACC-STRAP'),
      )?.quantity;
    assert.equal(strap([['OPENFC-LITE-2020', 4]]), 4);
    assert.equal(strap([['OPENMOTOR-1604', 4]]), 1);
    assert.equal(strap([['OPENFRAME-5', 2], ['OPENMOTOR-2306', 8]]), 2);
    assert.equal(strap([['OPENFC-LITE-3030', 50]]), 10);
  });

  it('leaves out what the cart holds and what the build parts already offer', () => {
    assert.deepEqual(skus(['OPENFRAME-5', 'ACC-STRAP-20X220'], ['ACC-PROP-5-GF-51466']), ['ACC-FRM-ARM-5']);
  });
});
