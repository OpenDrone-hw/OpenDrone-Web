import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {closedLabel, panelTransformOrigin, toggleHiddenBySheet} from './chatfpv-widget-ui.ts';

describe('closedLabel', () => {
  it('always carries "beta", with or without an unread reply', () => {
    assert.match(closedLabel(false), /beta/i);
    assert.match(closedLabel(true), /beta/i);
    assert.match(closedLabel(true), /unread/i);
    assert.doesNotMatch(closedLabel(false), /unread/i);
  });
});

describe('toggleHiddenBySheet', () => {
  it('hides the round launcher only while the phone sheet is open', () => {
    assert.equal(toggleHiddenBySheet(true, true), true);
    assert.equal(toggleHiddenBySheet(true, false), false);
    assert.equal(toggleHiddenBySheet(false, true), false);
    assert.equal(toggleHiddenBySheet(false, false), false);
  });
});

describe('panelTransformOrigin', () => {
  it('rolls out of the launcher (bottom-right) by default and for a right-docked handoff panel', () => {
    assert.equal(panelTransformOrigin(null), 'bottom right');
    assert.equal(panelTransformOrigin('right'), 'bottom right');
  });

  it('rolls out of its own near corner for a left-docked handoff panel, away from the launcher', () => {
    assert.equal(panelTransformOrigin('left'), 'bottom left');
  });
});
