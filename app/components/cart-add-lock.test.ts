import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {beginCartAdd, endCartAdd, isCartAddBusy, subscribeCartAdd} from './cart-add-lock.ts';

describe('cart add lock', () => {
  it('refuses a second submit fired while the first add runs', () => {
    const seen: boolean[] = [];
    const stop = subscribeCartAdd(() => seen.push(isCartAddBusy()));
    // Stack offer tapped, then Pre-order tapped before the first add settled.
    assert.equal(beginCartAdd(), true);
    assert.equal(beginCartAdd(), false);
    assert.equal(isCartAddBusy(), true);
    endCartAdd();
    assert.equal(isCartAddBusy(), false);
    // Once the first add settled, the next one goes through.
    assert.equal(beginCartAdd(), true);
    endCartAdd();
    stop();
    assert.deepEqual(seen, [true, false, true, false]);
  });

  it('ignores a release without a running add', () => {
    endCartAdd();
    assert.equal(isCartAddBusy(), false);
    assert.equal(beginCartAdd(), true);
    endCartAdd();
  });
});
