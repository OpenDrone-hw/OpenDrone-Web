import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {DOOR_LIMITS, TICKET_LIMITS, doorAllowed, ipBucket, ticketRateLimit} from './limits.ts';
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
      // The literal values never appear (a hex digest may contain "203" by chance).
      assert.ok(!r.key.includes('203.0.113.77') && !r.key.includes('secret-person'));
    }
  });

  it('stop at the first rule over its limit and write no IP-plus-email row then', async () => {
    const store = createStore(db!);
    const now = Date.parse('2026-09-03T12:00:00Z');
    const ip = '198.51.100.250';
    for (let i = 0; i < DOOR_LIMITS.findPerIp.limit; i++) {
      assert.ok(await doorAllowed(store, SECRET, [['findPerIp', ip], ['findPerIpEmail', ip, `p${i}@example.com`]], now + i));
    }
    const before = await db!.prepare('SELECT count(*) AS n FROM support_rate').first<{n: number}>();
    assert.equal(await doorAllowed(store, SECRET, [['findPerIp', ip], ['findPerIpEmail', ip, 'new@example.com']], now + 99), false);
    const after = await db!.prepare('SELECT count(*) AS n FROM support_rate').first<{n: number}>();
    assert.equal(Number(after!.n), Number(before!.n));
  });

  it('count an IPv6 client by its /64', async () => {
    const store = createStore(db!);
    const now = Date.parse('2026-09-04T12:00:00Z');
    for (let i = 0; i < DOOR_LIMITS.createPerIp.limit; i++) {
      assert.ok(await doorAllowed(store, SECRET, [['createPerIp', `2001:db8:aa:bb::${i + 1}`]], now + i));
    }
    assert.equal(await doorAllowed(store, SECRET, [['createPerIp', '2001:db8:aa:bb:ffff::9']], now + 50), false);
    assert.ok(await doorAllowed(store, SECRET, [['createPerIp', '2001:db8:aa:bc::1']], now + 60));
  });

  it('prune old windows', async () => {
    const store = createStore(db!);
    await store.hit('old-key', 1000, 1);
    await store.pruneRate(10);
    const row = await db!.prepare("SELECT count(*) AS n FROM support_rate WHERE key = 'old-key'").first<{n: number}>();
    assert.equal(Number(row!.n), 0);
  });
});

describe('ipBucket', () => {
  it('keeps IPv4, maps IPv4-in-IPv6 and cuts IPv6 to its /64', () => {
    assert.equal(ipBucket('203.0.113.9'), '203.0.113.9');
    assert.equal(ipBucket('::ffff:203.0.113.9'), '203.0.113.9');
    assert.equal(ipBucket('2001:0db8:0000:0001:0000:0000:0000:0001'), '2001:db8:0:1::/64');
    assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(ipBucket('2001:db8:0:1:ffff:1:2:3'), '2001:db8:0:1::/64');
    assert.equal(ipBucket('[2001:db8:0:1::5]'), '2001:db8:0:1::/64');
  });
});
