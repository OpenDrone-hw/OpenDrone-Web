import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

describe('launcher layering and placement (app.css)', () => {
  const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');
  const rule = (sel: string) => css.match(new RegExp(`^${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`, 'm'))?.[1] ?? '';
  it('sits under the drawer overlay (40) and dialogs while closed, above the pinned rail (60) while open', () => {
    assert.match(rule('.chatfpv-widget'), /z-index:\s*39;/);
    assert.match(rule('.chatfpv-widget.is-open'), /z-index:\s*61;/);
  });
  it('is fixed to the bottom-right corner with the safe-area inset', () => {
    assert.match(rule('.chatfpv-widget'), /position:\s*fixed;/);
    assert.match(rule('.chatfpv-widget'), /env\(safe-area-inset-bottom\)/);
  });
});
