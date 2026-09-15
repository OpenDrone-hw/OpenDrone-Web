import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {bindingRateLimit, checkRateLimit} from './rate-limit.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/rate-limit.test.ts

describe('checkRateLimit', () => {
  it('allows up to the limit, then denies within the window', () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      assert.equal(checkRateLimit(key, 3, 60_000).allowed, true);
    }
    const denied = checkRateLimit(key, 3, 60_000);
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
  });
});

describe('bindingRateLimit', () => {
  it('returns null when the binding is undefined (e.g. local dev)', async () => {
    const result = await bindingRateLimit(undefined, 'k1');
    assert.equal(result, null);
  });

  it('returns {allowed: true} when the binding reports success', async () => {
    const binding = {limit: async () => ({success: true})};
    const result = await bindingRateLimit(binding, 'k1');
    assert.deepEqual(result, {allowed: true});
  });

  it('returns {allowed: false} when the binding reports failure', async () => {
    const binding = {limit: async () => ({success: false})};
    const result = await bindingRateLimit(binding, 'k1');
    assert.deepEqual(result, {allowed: false});
  });

  it('returns null (degrade-soft), not throws, when the binding call fails', async () => {
    const binding = {
      limit: async () => {
        throw new Error('binding unavailable');
      },
    };
    const result = await bindingRateLimit(binding, 'k1');
    assert.equal(result, null);
  });

  it('passes the given key through to the binding', async () => {
    let seenKey: string | null = null;
    const binding = {
      limit: async (opts: {key: string}) => {
        seenKey = opts.key;
        return {success: true};
      },
    };
    await bindingRateLimit(binding, 'support-lookup:ip:1.2.3.4');
    assert.equal(seenKey, 'support-lookup:ip:1.2.3.4');
  });
});
