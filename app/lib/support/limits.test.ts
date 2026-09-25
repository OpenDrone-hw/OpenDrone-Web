import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {DOOR_LIMITS, TICKET_LIMITS, doorAllowed, ticketRateLimit} from './limits.ts';
import {createStore} from './store.ts';
import {testD1} from './testing.ts';

const db = await testD1();
const skip = db ? false : 'node:sqlite unavailable';
const SECRET = 'limits-secret';

describe('ticket limits (after authorisation, per isolate)', () => {
  it('allow the configured number of writes per ticket, then refuse', () => {
    const ref = `OD-TEST-${Math.random()}`;
    for (let i = 0; i < TICKET_LIMITS.write.limit; i++) assert.ok(ticketRateLimit('write', ref).allowed);
    assert.equal(ticketRateLimit('write', ref).allowed, false);
    assert.ok(ticketRateLimit('poll', ref).allowed, 'each kind has its own bucket');
  });
});

describe('door limits (D1, shared by isolates)', {skip}, () => {
  it('cap ticket creation per IP across isolates', async () => {
    const store = createStore(db!);
    const now = Date.parse('2026-09-01T12:00:00Z');
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < DOOR_LIMITS.createPerIp.limit; i++) {
      assert.ok(await doorAllowed(store, SECRET, [['createPerIp', ip]], now + i));
    }
    assert.equal(await doorAllowed(store, SECRET, [['createPerIp', ip]], now + 10), false);
    // A new window opens after an hour.
    assert.ok(await doorAllowed(store, SECRET, [['createPerIp', `${ip}x`]], now));
  });

  it('never lock one email out from another IP', async () => {
    const store = createStore(db!);
    const now = Date.parse('2026-09-02T12:00:00Z');
    for (let i = 0; i < DOOR_LIMITS.findPerIpEmail.limit + 3; i++) {
      await doorAllowed(store, SECRET, [['findPerIpEmail', '203.0.113.9', 'jan@example.com']], now + i);
    }
    assert.equal(await doorAllowed(store, SECRET, [['findPerIpEmail', '203.0.113.9', 'jan@example.com']], now + 50), false);
    assert.ok(await doorAllowed(store, SECRET, [['findPerIpEmail', '192.0.2.44', 'jan@example.com']], now + 60));
  });

  it('store hashed keys only, never the IP or email', async () => {
    const store = createStore(db!);
    await doorAllowed(store, SECRET, [['findPerIpEmail', '203.0.113.77', 'secret-person@example.com']], Date.now());
    const {results} = await db!.prepare('SELECT key FROM support_rate').all<{key: string}>();
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.match(r.key, /^[0-9a-f]{32}$/);
      assert.doesNotMatch(r.key, /203|example/);
    }
  });

  it('prune old windows', async () => {
    const store = createStore(db!);
    await store.hit('old-key', 1000, 1);
    await store.pruneRate(10);
    const row = await db!.prepare("SELECT count(*) AS n FROM support_rate WHERE key = 'old-key'").first<{n: number}>();
    assert.equal(Number(row!.n), 0);
  });
});
