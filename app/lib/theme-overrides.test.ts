import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {buildThemeCss} from './theme-overrides.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/theme-overrides.test.ts

describe('buildThemeCss', () => {
  it('emits nothing when there are no overrides', () => {
    assert.equal(buildThemeCss({}), '');
  });

  it('emits one isolated rule per declaration', () => {
    // Not one rule with many declarations: a value that still derails its own
    // rule then takes only itself down, not the whole theme.
    const css = buildThemeCss({'--color-bg': '#000', '--color-gold': 'gold'});
    assert.equal(css.match(/:root\{/g)?.length, 2);
  });

  it('drops an unbalanced url( without losing its neighbours', () => {
    // The value needs no `;` or `}` of its own: the generator supplies those,
    // and an unterminated function swallows them. This dropped every token.
    const css = buildThemeCss({
      '--color-bg': '#000011',
      '--evil': 'url(',
      '--color-accent': 'gold',
    });
    assert.ok(css.includes('--color-bg:#000011'));
    assert.ok(css.includes('--color-accent:gold'));
    assert.ok(!css.includes('--evil'));
  });

  for (const bad of ['url(', 'a)', '"open', "'open", 'rgb(1,2']) {
    it(`rejects the unbalanced value ${JSON.stringify(bad)}`, () => {
      assert.equal(buildThemeCss({'--x': bad}), '');
    });
  }

  for (const ok of ['#c89d2e', 'rgba(1, 2, 3, 0.5)', 'clamp(1rem, 2vw, 3rem)', '"Inter", sans-serif']) {
    it(`allows the balanced value ${JSON.stringify(ok)}`, () => {
      assert.ok(buildThemeCss({'--x': ok}).includes('--x:'));
    });
  }

  it('refuses a value that could close the block or open a comment', () => {
    for (const bad of ['red;color:blue', 'red}', 'red{', '/*', '*/', '<style>']) {
      assert.equal(buildThemeCss({'--x': bad}), '', `${bad} got through`);
    }
  });

  it('refuses a malformed custom property name', () => {
    for (const bad of ['color', '--a b', '--a;b', '-x', '']) {
      assert.equal(buildThemeCss({[bad]: 'red'}), '', `${bad} got through`);
    }
  });

  it('refuses a non-string value, so an object cannot reach the stylesheet', () => {
    assert.equal(buildThemeCss({'--x': {a: 1}}), '');
    assert.equal(buildThemeCss({'--x': 42}), '');
    assert.equal(buildThemeCss({'--x': null}), '');
  });
});
