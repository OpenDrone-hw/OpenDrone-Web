import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {voteShares, type VoteTally} from './votes.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/votes.test.ts

const tally: VoteTally = {
  updated: '2026-08-01',
  ballots: 6,
  points: {openvtx: 9, motors: 6, charger: 3},
  mentions: {openvtx: 4, motors: 3, charger: 2},
};

describe('voteShares', () => {
  it('is the percentage of points over the given candidates', () => {
    assert.deepEqual(voteShares(tally, ['openvtx', 'motors', 'charger']), {
      openvtx: 50,
      motors: 33,
      charger: 17,
    });
  });

  it('renormalises when a candidate leaves the set', () => {
    assert.deepEqual(voteShares(tally, ['openvtx', 'motors']), {
      openvtx: 60,
      motors: 40,
    });
  });

  it('is all zeros with no points, never a divide by zero', () => {
    const empty: VoteTally = {updated: '', ballots: 0, points: {}, mentions: {}};
    assert.deepEqual(voteShares(empty, ['openvtx']), {openvtx: 0});
  });

  it('counts an unknown candidate as zero rather than dropping it', () => {
    assert.equal(voteShares(tally, ['openvtx', 'nope']).nope, 0);
  });
});
