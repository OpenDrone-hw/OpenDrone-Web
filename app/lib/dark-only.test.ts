import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

// Run with:
//   node --experimental-strip-types --test app/lib/dark-only.test.ts
//
// The site is dark only (founder 2026-10-24). This fails if a light palette,
// a theme toggle or a theme storage key comes back.

const APP = new URL('..', import.meta.url).pathname;

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('dark only', () => {
  const css = files(join(APP, 'styles'), /\.css$/).filter(
    (f) => !f.endsWith('opendrone-tokens.css'), // vendored from the brand repo
  );

  it('has no light selector or light media query in the stylesheets', () => {
    assert.ok(css.length > 0);
    for (const f of css) {
      const s = strip(readFileSync(f, 'utf8'));
      assert.ok(!/html\.light|:not\(\.light\)|\[data-theme=["']?light/.test(s), `${f}: light selector`);
      assert.ok(!/prefers-color-scheme:\s*light/.test(s), `${f}: prefers-color-scheme: light`);
      assert.ok(!/color-scheme:\s*light/.test(s), `${f}: color-scheme: light`);
    }
  });

  it('declares color-scheme: dark on html', () => {
    const s = strip(readFileSync(join(APP, 'styles/app.css'), 'utf8'));
    assert.match(s, /\nhtml\s*\{[^}]*color-scheme:\s*dark/);
  });

  it('has no theme toggle, theme storage key or light class in the code', () => {
    for (const f of files(APP, /\.(ts|tsx)$/).filter((f) => !f.endsWith('dark-only.test.ts'))) {
      const s = readFileSync(f, 'utf8');
      assert.ok(!/ThemeToggle|theme-toggle|od-theme|THEME_INIT_SCRIPT|getActiveTheme/.test(s), `${f}: theme switching`);
      assert.ok(!/classList\.(contains|add|remove|toggle)\(['"]light['"]/.test(s), `${f}: light class`);
    }
  });

  it('ships no light-only map', () => {
    assert.ok(!existsSync(join(APP, '../public/makerspace/map-light.svg')));
  });
});
