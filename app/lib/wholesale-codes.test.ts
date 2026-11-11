import assert from 'node:assert/strict';
import {describe, it, test} from 'node:test';
import {cartWholesaleCode, wholesaleCodes, wholesaleFieldShown, wholesaleMainCode, wholesaleVisit} from './wholesale-codes.ts';

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
});

describe('the cart shows the wholesale code field to retailers only', () => {
  const u = (path: string) => new URL(path, 'https://opendrone.be');
  it('marks a visit through the wholesale page or a link with the wholesale parameter', () => {
    assert.equal(wholesaleVisit(u('/wholesale')), true);
    assert.equal(wholesaleVisit(u('/nl/wholesale')), true);
    assert.equal(wholesaleVisit(u('/cart?wholesale=1')), true);
    assert.equal(wholesaleVisit(u('/products/openfc-lite?wholesale')), true);
    assert.equal(wholesaleVisit(u('/cart')), false);
    assert.equal(wholesaleVisit(u('/products?q=wholesale')), false);
  });
  it('choice on: hidden for a normal visitor, shown for a retailer visit or an applied code', () => {
    assert.equal(wholesaleFieldShown({choice: true, visited: false, applied: false}), false);
    assert.equal(wholesaleFieldShown({choice: true, visited: true, applied: false}), true);
    assert.equal(wholesaleFieldShown({choice: true, visited: false, applied: true}), true);
  });
  it('choice off: shown as before', () => {
    assert.equal(wholesaleFieldShown({choice: false, visited: false, applied: false}), true);
  });
});
