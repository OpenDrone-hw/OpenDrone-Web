import assert from 'node:assert/strict';
import {describe, it, test} from 'node:test';
import {cartDiscountCode, cartWholesaleCode, codesToApply, discountCodeInput, wholesaleCartPath, wholesaleCodes, wholesaleMainCode} from './wholesale-codes.ts';

test('a wholesale code is normalised and expands to its price groups', () => {
  assert.equal(wholesaleMainCode(' ws25-fpv24 '), 'WS25-FPV24');
  assert.deepEqual(wholesaleCodes('WS25-FPV24'), ['WS25-FPV24', 'WS25-FPV24-G2', 'WS25-FPV24-G3', 'WS25-FPV24-G4']);
});

test('anything else is not a wholesale code', () => {
  for (const bad of ['', 'SUMMER10', 'WS25', 'WS25-', 'WS25-FPV24-G2', 'WS-FPV24', 'WS250-X1']) {
    assert.equal(wholesaleMainCode(bad), null, bad);
  }
});

describe('cartWholesaleCode', () => {
  it('finds the main code and skips its price-group companions', () => {
    const codes = [
      {code: 'WS25-DRONEFACTORY-G2', applicable: false},
      {code: 'WS25-DRONEFACTORY', applicable: true},
    ];
    assert.deepEqual(cartWholesaleCode(codes), {code: 'WS25-DRONEFACTORY', applicable: true});
    assert.equal(cartWholesaleCode([{code: 'WS25-X1-G3', applicable: true}]), null);
    assert.equal(cartWholesaleCode(undefined), null);
  });
  it('counts as applied when only a companion applies (a cart of one price group)', () => {
    const codes = [
      {code: 'WS25-FPV24', applicable: false},
      {code: 'WS25-FPV24-G2', applicable: true},
      {code: 'WS25-FPV24-G3', applicable: false},
    ];
    assert.deepEqual(cartWholesaleCode(codes), {code: 'WS25-FPV24', applicable: true});
    assert.deepEqual(cartWholesaleCode([{code: 'WS25-FPV24', applicable: false}, {code: 'WS25-OTHER-G2', applicable: true}]), {code: 'WS25-FPV24', applicable: false});
  });
});

describe('the cart discount code field', () => {
  it('takes any Shopify-shaped code; a wholesale code brings its price groups', () => {
    assert.equal(discountCodeInput(' summer 10 '), 'SUMMER10');
    assert.equal(discountCodeInput('ws25-fpv24'), 'WS25-FPV24');
    for (const bad of ['', ' ', 'A', 'x'.repeat(41), 'NO!CODE']) assert.equal(discountCodeInput(bad), null, bad);
    assert.deepEqual(codesToApply('SUMMER10'), ['SUMMER10']);
    assert.deepEqual(codesToApply('WS25-FPV24'), wholesaleCodes('WS25-FPV24'));
  });
  it('shows a retailer main code for its family, else the code Shopify took', () => {
    assert.deepEqual(cartDiscountCode([{code: 'WS25-X1', applicable: false}, {code: 'WS25-X1-G2', applicable: true}]), {code: 'WS25-X1', applicable: true});
    assert.deepEqual(cartDiscountCode([{code: 'SUMMER10', applicable: true}]), {code: 'SUMMER10', applicable: true});
    assert.deepEqual(cartDiscountCode([{code: 'OLD', applicable: false}]), {code: 'OLD', applicable: false});
    assert.equal(cartDiscountCode([]), null);
  });
  it('a code apply returns to the cart, with its notice', () => {
    assert.equal(wholesaleCartPath(), '/cart');
    assert.equal(wholesaleCartPath('code'), '/cart?check=code');
  });
});
