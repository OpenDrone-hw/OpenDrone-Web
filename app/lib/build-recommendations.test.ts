import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  buildProfileId,
  buildSuggestionSpecs,
  resolveBuildSuggestions,
  resolveProfile,
} from './build-recommendations.ts';
import type {ProductCardFragment, ProductVariantFragment} from './product-shapes.ts';

describe('build profile', () => {
  it('reads the size only from an unambiguous component SKU', () => {
    assert.equal(buildProfileId('OPENFC-LITE-2020'), '3-inch');
    assert.equal(buildProfileId('OPENFRAME-5'), '5-inch');
    assert.equal(buildProfileId('OPENMOTOR-1604'), '3-inch');
    assert.equal(buildProfileId('OPENRX-LITE'), null);
  });

  it('falls back to a sized part already in the cart for a size-neutral add', () => {
    assert.equal(resolveProfile('OPENRX-MONO', ['OPENRX-MONO', 'OPENESC-3030']), '5-inch');
    assert.equal(resolveProfile('OPENRX-MONO', ['OPENRX-MONO']), null);
    assert.equal(resolveProfile('OPENESC-2020', ['OPENFRAME-5']), '3-inch');
  });
});

describe('buildSuggestionSpecs', () => {
  it('suggests four matching motors and a size-appropriate receiver', () => {
    const compact = buildSuggestionSpecs('3-inch', ['openfc-lite']);
    assert.deepEqual(
      compact.map(({sku, quantity}) => [sku, quantity]),
      [['OPENESC-2020', 1], ['OPENFRAME-3', 1], ['OPENMOTOR-1604', 4], ['OPENRX-LITE', 1]],
    );
    assert.ok(buildSuggestionSpecs('5-inch').some(({sku}) => sku === 'OPENRX-GEMINI'));
  });

  it('skips products already in the cart, whatever their size', () => {
    const specs = buildSuggestionSpecs('3-inch', ['openfc-lite', 'openesc', 'openrx']);
    assert.deepEqual(specs.map(({handle}) => handle), ['openframe', 'openmotor']);
  });

  it('lets Shopify rank compatible parts without adding incompatible ones', () => {
    const ranked = buildSuggestionSpecs('3-inch', ['openfc-lite'], ['openrx', 'openmotor', 'elsewhere']);
    assert.deepEqual(ranked.map(({handle}) => handle), ['openrx', 'openmotor', 'openesc', 'openframe']);
    assert.ok(ranked.every(({sku}) => !sku.endsWith('3030') && !sku.endsWith('2207')));
  });
});

function card(handle: string, sku: string, availableForSale = true): ProductCardFragment {
  const variant = {sku, availableForSale} as ProductVariantFragment;
  return {handle, variants: {nodes: [variant]}} as ProductCardFragment;
}

describe('resolveBuildSuggestions', () => {
  it('keeps only variants that exist, are for sale and pass the status gate', () => {
    const products = [
      card('openesc', 'OPENESC-2020'),
      card('openframe', 'OPENFRAME-3', false),
      card('openmotor', 'OPENMOTOR-1604'),
    ];
    const specs = buildSuggestionSpecs('3-inch', ['openfc-lite']);
    const out = resolveBuildSuggestions(products, specs, (handle) => handle !== 'openmotor');
    assert.deepEqual(out.map(({sku}) => sku), ['OPENESC-2020']);
  });
});
