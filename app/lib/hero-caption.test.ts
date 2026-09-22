import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {heroCaption, PRODUCT_CONTENT} from './product-content.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/hero-caption.test.ts

describe('heroCaption', () => {
  it('keeps a decimal point inside its sentence (OpenRX "2.4 GHz")', () => {
    const caption = heroCaption('openrx');
    assert.ok(caption, 'openrx has a hero caption');
    assert.ok(
      !/^\d/.test(caption.split('. ')[1] ?? ''),
      `caption splits inside a number: ${caption}`,
    );
    const intro = PRODUCT_CONTENT.openrx?.whatIsThis?.intro ?? '';
    assert.ok(intro.startsWith(caption), `caption is not the start of the intro: ${caption}`);
    if (intro.includes('2.4 GHz')) {
      assert.ok(
        caption.includes('2.4 GHz') || !caption.includes('GHz'),
        `caption drops the "2." of "2.4 GHz": ${caption}`,
      );
    }
  });

  it('never starts a sentence with a bare number fragment for any product', () => {
    for (const handle of Object.keys(PRODUCT_CONTENT)) {
      const caption = heroCaption(handle);
      if (!caption) continue;
      assert.ok(
        !/(^|\. )\d+(\s|$)/.test(caption) || /\d\.\d/.test(caption),
        `${handle}: ${caption}`,
      );
      const intro = PRODUCT_CONTENT[handle]?.whatIsThis?.intro ?? '';
      if (!PRODUCT_CONTENT[handle]?.whatIsThis?.hero) {
        assert.ok(intro.startsWith(caption), `${handle}: caption is not a prefix of the intro`);
      }
    }
  });
});
