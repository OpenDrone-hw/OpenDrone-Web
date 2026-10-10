import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {fmt, nearestIndex, niceDomain, niceTicks, project} from './chart-math.ts';

// Run with:
//   node --experimental-strip-types --test app/components/testing/chart-math.test.ts

describe('chart math', () => {
  it('makes round ticks inside the range', () => {
    assert.deepEqual(niceTicks(0, 1000, 5), [0, 200, 400, 600, 800, 1000]);
    assert.deepEqual(niceTicks(0.3, 9.7, 5), [2, 4, 6, 8]);
  });
  it('widens a domain to tick boundaries', () => {
    assert.deepEqual(niceDomain(0.39, 64.7, 5), [0, 80]);
  });
  it('finds the nearest index by binary search', () => {
    const xs = [0, 10, 20, 40];
    assert.equal(nearestIndex(xs, -5), 0);
    assert.equal(nearestIndex(xs, 14), 1);
    assert.equal(nearestIndex(xs, 31), 3);
    assert.equal(nearestIndex(xs, 99), 3);
    assert.equal(nearestIndex([], 1), -1);
  });
  it('projects linear and log', () => {
    assert.equal(project({kind: 'linear', d0: 0, d1: 10, r0: 0, r1: 100}, 5), 50);
    assert.equal(project({kind: 'log', d0: 1, d1: 100, r0: 0, r1: 100}, 10), 50);
  });
  it('formats to four significant digits', () => {
    assert.equal(fmt(1.03412), '1.034');
    assert.equal(fmt(1496.4), '1496');
    assert.equal(fmt(0), '0');
  });
});
