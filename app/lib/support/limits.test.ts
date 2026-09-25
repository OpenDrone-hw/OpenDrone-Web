import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {SUPPORT_LIMITS, TICKETS_PER_EMAIL_PER_DAY, emailOverDailyLimit, supportRateLimit} from './limits.ts';
import {createStore} from './store.ts';
import {testD1} from './testing.ts';

const db = await testD1();

describe('support rate limits', () => {
  it('allow the configured number of requests per key, then refuse', () => {
    const key = `ip-${Math.random()}`;
    for (let i = 0; i < SUPPORT_LIMITS.create.limit; i++) assert.ok(supportRateLimit('create', key).allowed);
    const refused = supportRateLimit('create', key);
    assert.equal(refused.allowed, false);
    assert.ok(refused.resetInSeconds > 0);
    assert.ok(supportRateLimit('create', `${key}-other`).allowed);
    assert.ok(supportRateLimit('find', key).allowed, 'each kind has its own bucket');
  });

  it('cap new tickets per email per day in the store', {skip: db ? false : 'node:sqlite unavailable'}, async () => {
    const store = createStore(db!);
    const now = Date.parse('2026-09-01T12:00:00Z');
    for (let i = 0; i < TICKETS_PER_EMAIL_PER_DAY; i++) {
      assert.equal(await emailOverDailyLimit(store, 'a@example.com', now), false);
      await store.insertTicket({
        ref: `OD-AAAA-000${i}`, topic: 'other', subject: 's', status: 'open', name: 'A', email: 'a@example.com',
        orderNumber: null, product: null, threadId: `t${i}`, cursor: null, customerId: null, customerMatch: 'none',
        linkVersion: 1, createdAt: now - i * 1000, updatedAt: now, lastCustomerAt: now, lastStaffAt: null,
        customerSeenAt: null, notifiedAt: null, syncedAt: null, closedAt: null,
      });
    }
    assert.equal(await emailOverDailyLimit(store, 'a@example.com', now), true);
    assert.equal(await emailOverDailyLimit(store, 'a@example.com', now + 25 * 3600 * 1000), false);
    assert.equal(await emailOverDailyLimit(store, 'b@example.com', now), false);
  });
});
