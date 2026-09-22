import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {campaignChip} from './roadmap-data.ts';

describe('campaignChip', () => {
  it('is null outside a campaign', () => {
    assert.equal(campaignChip(null), null);
    assert.equal(campaignChip(undefined), null);
  });

  it('names a paid first batch', () => {
    assert.equal(
      campaignChip({paidStock: true, target: 250, targetReached: false}),
      'first-batch',
    );
  });

  it('names an open funding target', () => {
    assert.equal(
      campaignChip({paidStock: false, target: 250, targetReached: false}),
      'funding',
    );
  });

  it('names a reached target', () => {
    assert.equal(
      campaignChip({paidStock: false, target: 250, targetReached: true}),
      'funded',
    );
  });
});
