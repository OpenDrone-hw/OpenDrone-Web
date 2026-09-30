import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {CHATFPV_OPEN_EVENT, PHONE_MAX_WIDTH_PX, closedLabel, panelTransformOrigin, toggleHiddenBySheet} from './chatfpv-widget-ui.ts';

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

describe('no floating launcher on phones (audit round 3 A4)', () => {
  const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');
  const widget = readFileSync(new URL('./ChatFpvWidget.tsx', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('./ChatFpvEntry.tsx', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('./PageLayout.tsx', import.meta.url), 'utf8');
  const product = readFileSync(new URL('../routes/products.$handle.tsx', import.meta.url), 'utf8');

  it('hides the launcher at 959px and narrower, where the layout is one column', () => {
    assert.equal(PHONE_MAX_WIDTH_PX, 767);
    assert.match(css, /@media \(max-width: 959px\) \{\s*\.chatfpv-widget-toggle \{\s*display: none;/);
  });

  it('opens the same panel from the menu entry and the inline link through one event', () => {
    assert.equal(CHATFPV_OPEN_EVENT, 'chatfpv:open');
    assert.match(widget, /addEventListener\(CHATFPV_OPEN_EVENT/);
    assert.match(entry, /requestChatFpvOpen/);
    assert.match(entry, />\s*Ask ChatFPV\s*</);
    assert.match(entry, /Questions\?/);
    assert.match(layout, /<ChatFpvMenuEntry \/>/);
    assert.equal((product.match(/<ChatFpvInlineLink \/>/g) ?? []).length, 2);
  });

  it('shows the entries only where a widget is mounted', () => {
    assert.match(css, /\.chatfpv-entry \{\s*display: none;/);
    assert.match(css, /\.chatfpv-widget-on \.chatfpv-entry-menu \{\s*display: inline-flex/);
  });
});
