import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS,
  SURFACE,
  allSeriesColors,
  assignStyles,
  contrast,
  domainColor,
} from './palette.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/testing/palette.test.ts

describe('series palette', () => {
  it('passes 4.5:1 on the surface and the canvas in both themes', () => {
    const bad = allSeriesColors()
      .flatMap((c) => [
        {...c, on: SURFACE[c.theme], ratio: contrast(c.color, SURFACE[c.theme])},
        {...c, on: CANVAS[c.theme], ratio: contrast(c.color, CANVAS[c.theme])},
      ])
      .filter((c) => c.ratio < 4.5);
    assert.deepEqual(
      bad.map((c) => `${c.quantity}/${c.variant}/${c.theme} ${c.ratio.toFixed(2)}`),
      [],
    );
  });

  it('domain colours pass too', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const d of ['THR', 'PWR', 'THM', 'RF', 'other']) {
        assert.ok(contrast(domainColor(d, theme), SURFACE[theme]) >= 4.5, `${d} ${theme}`);
      }
    }
  });

  it('never uses the teal identity colour for a series', () => {
    for (const c of allSeriesColors()) {
      assert.notEqual(c.color.toUpperCase(), '#00B2A9');
      assert.notEqual(c.color.toUpperCase(), '#00827B');
    }
  });

  it('gives packs of one quantity different dashes, and a pack the same style across kinds', () => {
    const s = assignStyles(
      [
        {id: 'a', quantity: 'thrust', pack: 'p1', kind: 'frames'},
        {id: 'b', quantity: 'thrust', pack: 'p2', kind: 'frames'},
        {id: 'c', quantity: 'thrust', pack: 'p1', kind: 'hold'},
      ],
      'light',
    );
    assert.notDeepEqual(s.a!.dash, s.b!.dash);
    assert.notEqual(s.a!.color, s.b!.color);
    assert.equal(s.a!.color, s.c!.color);
    assert.ok(s.a!.width < s.c!.width, 'frames are thinner than holds');
    assert.ok(s.a!.opacity < 1);
  });
});
