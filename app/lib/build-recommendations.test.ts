import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {
  buildOf,
  buildSuggestionSpecs,
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
  it('suggests four matching motors and a size-appropriate receiver', () => {
    const specs = buildSuggestionSpecs(BUILDS, '3-inch', [{sku: 'OPENFC-LITE-2020', handle: 'openfc-lite'}]);
    assert.deepEqual(
      specs.map(({sku, quantity}) => [sku, quantity]),
      [['OPENESC-2020', 1], ['OPENFRAME-3', 1], ['OPENMOTOR-1604', 4], ['OPENRX-LITE-UFL', 1], ['ACC-PROP-3-HQ-T3X3X3', 1]],
    );
  });

  it('suggests props for the size and no antenna: receivers ship with one', () => {
    const specs = buildSuggestionSpecs(BUILDS, '5-inch', [{sku: 'OPENMOTOR-2207', handle: 'openmotor'}]);
    const props = specs.find((s) => s.role === 'props');
    assert.equal(props?.sku, 'ACC-PROP-5-HQ-5X43X3-V2S');
    assert.equal(props?.handle, 'hqprop-5x4-3x3-v2s-propeller-set-5-inch');
    assert.equal(specs.some((s) => s.role === 'antenna'), false);
    const three = buildSuggestionSpecs(BUILDS, '3-inch', [{sku: 'OPENFRAME-3', handle: 'openframe'}]);
    assert.equal(three.some((s) => s.role === 'antenna'), false);
    assert.equal(buildOf(BUILDS, 'ACC-PROP-3-HQ-T3X3X3'), '3-inch');
  });

  it('matches the final 5-inch CAD receiver', () => {
    const specs = buildSuggestionSpecs(BUILDS, '5-inch', [{sku: 'OPENFC-LITE-3030', handle: 'openfc-lite'}]);
    assert.equal(specs.find((s) => s.role === 'receiver')?.sku, 'OPENRX-MONO');
  });

  it('still suggests the right-size ESC when the cart holds the other size, and says so', () => {
    const cart = [
      {sku: 'OPENESC-2020', handle: 'openesc', variantTitle: '20×20'},
      {sku: 'OPENRX-LITE', handle: 'openrx', variantTitle: 'Lite'},
      {sku: 'OPENFC-LITE-3030', handle: 'openfc-lite', variantTitle: '30×30'},
    ];
    const specs = buildSuggestionSpecs(BUILDS, '5-inch', cart);
    const esc = specs.find((s) => s.role === 'esc');
    assert.equal(esc?.sku, 'OPENESC-3030');
    assert.equal(esc?.replaces, '20×20');
    // Any receiver fills the receiver role; the FC role is filled at this size.
    assert.equal(specs.some((s) => s.role === 'receiver' || s.role === 'flight-controller'), false);
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
    assert.ok(ranked.every(({sku}) => !sku.endsWith('3030') && !sku.endsWith('2207')));
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
