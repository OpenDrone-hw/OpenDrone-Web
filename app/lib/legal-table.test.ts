import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';

// legal.ts imports Vite ?raw Markdown, so node:test cannot load it; assert the
// converter source and the stylesheet instead (same pattern as the other
// source-contract tests).
const read = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const legal = read('./legal.ts');
const css = read('../styles/app.css');

describe('legal tables are keyboard-scrollable (WCAG 2.1.1)', () => {
  it('wraps each table in a named, focusable region', () => {
    assert.match(legal, /<div class="table-scroll" role="region" tabindex="0"/);
    assert.match(legal, /aria-label="\$\{name\}"/);
    assert.match(legal, /<\/table><\/div>/);
  });
  it('scrolls the wrapper and gives it a visible focus ring', () => {
    assert.match(css, /\.legal-body \.table-scroll \{[^}]*overflow-x: auto/);
    assert.match(css, /\.legal-body \.table-scroll:focus-visible \{[^}]*outline: 2px solid/);
  });
});
