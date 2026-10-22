import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {cartChanges, changeText, seenOf} from './app-cart-seen.ts';
import {cleanOptions} from './app-cart-options.ts';

const line = (o: object) => ({variant: 'v1', title: 'Kit', variant_title: '', qty: 1, unit_minor: 1000, total_minor: 1000, ship_promise: 'Ships in May', ...o});
const money = (n: number) => `E${n / 100}`;

describe('cart changes', () => {
  it('says nothing for a first visit or an unchanged cart', () => {
    assert.deepEqual(cartChanges(undefined, [line({})], money), []);
    assert.deepEqual(cartChanges(seenOf([line({})]), [line({})], money), []);
  });
  it('names a changed price and a changed ship date', () => {
    const seen = seenOf([line({})]);
    const out = cartChanges(seen, [line({unit_minor: 1200, ship_promise: 'Ships in June'})], money);
    assert.deepEqual(out.map((c) => c.kind), ['price', 'ship']);
    assert.equal(changeText(out[0]), 'Kit: the price changed from E10 to E12.');
    assert.ok(!changeText(out[1]).includes('—'));
  });
  it('ignores a missing ship date and keeps seen values through the cookie cleaner', () => {
    assert.deepEqual(cartChanges(seenOf([line({})]), [line({ship_promise: null})], money), []);
    assert.deepEqual(cleanOptions({seen: {v1: {unit: 5, ship: 'x'}, 'bad key!': {unit: 1, ship: ''}, v2: {unit: 1.5, ship: ''}}}).seen, {v1: {unit: 5, ship: 'x'}});
  });
});
