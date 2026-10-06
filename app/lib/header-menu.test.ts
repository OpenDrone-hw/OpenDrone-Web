import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {HEADER_MENU_LINKS} from './header-menu.ts';

const header = readFileSync(new URL('../components/Header.tsx', import.meta.url), 'utf8');
const chrome = JSON.parse(
  readFileSync(new URL('../../content/copy/chrome.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('header menu button', () => {
  it('lists every destination the bar used to show as text', () => {
    assert.deepEqual(
      HEADER_MENU_LINKS.map((l) => l.to),
      ['/preorder', '/wholesale', '/newsletter', '/owners', '/support'],
    );
  });

  it('has copy for each link', () => {
    for (const l of HEADER_MENU_LINKS) {
      assert.ok(chrome[l.copy.replace(/^chrome\./, '')], l.copy);
    }
  });

  it('keeps the same destinations in the phone drawer', () => {
    for (const l of HEADER_MENU_LINKS) {
      assert.ok(header.includes(`url: '${l.to}'`), `drawer lacks ${l.to}`);
    }
  });

  it('keeps ChatFPV in the phone drawer', () => {
    const layout = readFileSync(new URL('../components/PageLayout.tsx', import.meta.url), 'utf8');
    assert.ok(layout.includes('<ChatFpvMenuEntry />'));
  });
});
