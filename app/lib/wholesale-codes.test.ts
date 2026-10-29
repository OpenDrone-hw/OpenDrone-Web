import assert from 'node:assert/strict';
import {test} from 'node:test';
import {wholesaleCodes, wholesaleMainCode} from './wholesale-codes.ts';

test('a wholesale code is normalised and expands to its price groups', () => {
  assert.equal(wholesaleMainCode(' ws25-fpv24 '), 'WS25-FPV24');
  assert.deepEqual(wholesaleCodes('WS25-FPV24'), ['WS25-FPV24', 'WS25-FPV24-G2', 'WS25-FPV24-G3', 'WS25-FPV24-G4']);
});

test('anything else is not a wholesale code', () => {
  for (const bad of ['', 'SUMMER10', 'WS25', 'WS25-', 'WS25-FPV24-G2', 'WS-FPV24', 'WS250-X1']) {
    assert.equal(wholesaleMainCode(bad), null, bad);
  }
});
