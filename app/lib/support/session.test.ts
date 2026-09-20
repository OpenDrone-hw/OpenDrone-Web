import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {randomTicketId, supportHistoryDestination} from './session.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/support/session.test.ts

describe('randomTicketId', () => {
  it('returns a 10-digit numeric string', () => {
    for (let i = 0; i < 50; i++) {
      const id = randomTicketId();
      assert.equal(id.length, 10, `len mismatch for ${id}`);
      assert.match(id, /^\d{10}$/, `non-digit char in ${id}`);
    }
  });

  it('uniqueness in a tiny batch (statistical sanity)', () => {
    // Birthday-paradox over a 10000-slot tail with 5 picks gives a
    // collision probability of ~0.1%, low enough for CI stability.
    // Larger batch sizes would flake under tight loops in the same
    // wall-second.
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) seen.add(randomTicketId());
    assert.equal(seen.size, 5, `only ${seen.size}/5 unique`);
  });

  it('first six chars are seconds-of-cycle, monotonically near current time', () => {
    const id = randomTicketId();
    const head = parseInt(id.slice(0, 6), 10);
    const now = Math.floor(Date.now() / 1000) % 1_000_000;
    // Must match the current cycle-second within 2s of timer slop.
    assert.ok(
      Math.abs(head - now) <= 2,
      `head=${head} now=${now} drift too large`,
    );
  });
});

describe('retired support history route', () => {
  it('hands preview visitors to native contacts without exposing an archive', () => {
    assert.equal(supportHistoryDestination(true), '/support?existing=1');
    assert.equal(supportHistoryDestination(false), '/support/tickets');
  });
});
