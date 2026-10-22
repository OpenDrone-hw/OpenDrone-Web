import assert from 'node:assert/strict';
import {test} from 'node:test';
import {preorderHoldsEnabled} from './preorder-ops.ts';

test('holds are on when nothing is set', () => {
  assert.equal(preorderHoldsEnabled({}), true);
});

test('PREORDER_HOLDS_ENABLED "0" turns holds off', () => {
  assert.equal(preorderHoldsEnabled({PREORDER_HOLDS_ENABLED: '0'}), false);
  assert.equal(preorderHoldsEnabled({PREORDER_HOLDS_ENABLED: ' 0 '}), false);
});

test('any other value, or an empty one, leaves holds on', () => {
  assert.equal(preorderHoldsEnabled({PREORDER_HOLDS_ENABLED: '1'}), true);
  assert.equal(preorderHoldsEnabled({PREORDER_HOLDS_ENABLED: ''}), true);
});

test('a staging password still turns holds off', () => {
  assert.equal(preorderHoldsEnabled({STAGING_PASSWORD: 'x'}), false);
  assert.equal(preorderHoldsEnabled({STAGING_PASSWORD: 'x', PREORDER_HOLDS_ENABLED: '1'}), false);
});
