import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('teardown pin rows: a real button inside the li, no tabindex on the li', () => {
  const src = read('../routes/products.$handle.tsx');
  assert.match(src, /<button\s+type="button"\s+className="teardown-pin-btn"\s+aria-pressed=\{isActive\}/);
  assert.doesNotMatch(src, /tabIndex: 0/);
  const css = read('../styles/app.css');
  assert.match(css, /\.teardown-pin-btn:focus-visible\s*\{[^}]*outline: 2px solid/);
});

test('schematic and copper-layer rails show a focus-visible ring', () => {
  const css = read('../styles/app.css');
  assert.match(
    css,
    /\.board-folder-rail:focus-visible,\s*\.schematic-rail:focus-visible\s*\{[^}]*outline: 2px solid var\(--color-focus\)/,
  );
});

test('editorial aside is not an unnamed complementary landmark', () => {
  assert.doesNotMatch(read('../components/EditorialShell.tsx'), /<aside/);
});
