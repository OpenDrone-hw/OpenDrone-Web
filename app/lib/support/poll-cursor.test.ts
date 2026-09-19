import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {computeCursorTarget} from './poll-cursor.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/support/poll-cursor.test.ts

const m = (id: string) => ({id});

describe('computeCursorTarget', () => {
  it('advances to the newest message when nothing is held', () => {
    const messages = [m('1'), m('2'), m('3')];
    assert.equal(computeCursorTarget(messages, new Set(), '0'), '3');
  });

  it('keeps the prior cursor when the window is empty', () => {
    assert.equal(computeCursorTarget([], new Set(), '7'), '7');
    assert.equal(computeCursorTarget([], new Set(), undefined), undefined);
  });

  it('parks just before the earliest held message', () => {
    // Staff reply "3" arrived but is awaiting moderator approval. The
    // cursor must stop at "2" so the next poll re-fetches "3" and can
    // deliver it the moment it's approved.
    const messages = [m('1'), m('2'), m('3')];
    assert.equal(computeCursorTarget(messages, new Set(['3']), '0'), '2');
  });

  it('does not advance when the oldest message in the window is held', () => {
    // If we advanced at all we would skip the held message the instant
    // it is approved - the exact "had to refresh" bug.
    const messages = [m('1'), m('2'), m('3')];
    assert.equal(computeCursorTarget(messages, new Set(['1']), '0'), '0');
  });

  it('parks before the EARLIEST held message when several are held', () => {
    const messages = [m('1'), m('2'), m('3'), m('4')];
    assert.equal(
      computeCursorTarget(messages, new Set(['2', '4']), '0'),
      '1',
    );
  });

  it('returns undefined (no change) when oldest held and no prior cursor', () => {
    const messages = [m('1'), m('2')];
    assert.equal(computeCursorTarget(messages, new Set(['1']), undefined), undefined);
  });

  it('delivers held replies on a later poll once approved', () => {
    // Poll 1: "3" held -> cursor parks at "2".
    const window1 = [m('1'), m('2'), m('3')];
    const cursor1 = computeCursorTarget(window1, new Set(['3']), '0');
    assert.equal(cursor1, '2');
    // Poll 2: same window re-fetched (after=2 still returns 3), now
    // approved -> heldIds empty -> cursor advances past it.
    const window2 = [m('3')];
    const cursor2 = computeCursorTarget(window2, new Set(), cursor1);
    assert.equal(cursor2, '3');
  });
});
