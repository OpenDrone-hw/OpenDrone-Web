import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {CART_PLACEMENTS, addToCartEventProps, resolvePlacement} from './cart-placement.ts';

describe('add to cart placement', () => {
  it('prefers the button, then the surface around it', () => {
    assert.equal(resolvePlacement('related', 'buy_box', 'openesc'), 'related');
    assert.equal(resolvePlacement(null, 'sticky_bar', 'openesc'), 'sticky_bar');
    assert.equal(resolvePlacement(undefined, 'build_block', 'build-3-inch'), 'build_block');
  });

  it('reads an unlabelled build add as the homepage build card', () => {
    assert.equal(resolvePlacement(null, null, 'build-5-inch'), 'home_build');
  });

  it('reports an unlabelled button as unknown, never as a real surface', () => {
    assert.equal(resolvePlacement(null, null, 'openesc'), 'unknown');
  });

  it('puts the placement in the event props', () => {
    assert.deepEqual(
      addToCartEventProps({product: 'build-3-inch', skus: ['OPENFC-LITE-2020', 'OPENESC-2020'], placement: 'build_block'}),
      {product: 'build-3-inch', sku: 'OPENFC-LITE-2020+OPENESC-2020', placement: 'build_block'},
    );
    assert.deepEqual(addToCartEventProps({product: null, skus: [], placement: 'unknown'}), {
      product: 'unknown',
      sku: 'unknown',
      placement: 'unknown',
    });
  });

  it('has one known placement per surface and the button sends it', () => {
    assert.deepEqual([...CART_PLACEMENTS].sort(), [
      'build_block',
      'buy_box',
      'cart_dialog',
      'catalog',
      'home_build',
      'related',
      'sticky_bar',
    ]);
    const button = fs.readFileSync(new URL('../components/AddToCartButton.tsx', import.meta.url), 'utf8');
    assert.match(button, /addToCartEventProps\(/);
    assert.match(button, /resolvePlacement\(/);
  });
});
