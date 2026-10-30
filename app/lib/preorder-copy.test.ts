import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Run with:
//   node --experimental-strip-types --test app/lib/preorder-copy.test.ts

const copy = JSON.parse(
  readFileSync(new URL('../../content/copy/preorder.json', import.meta.url), 'utf8'),
) as Record<string, string>;

describe('/preorder channel copy', () => {
  it('does not say non-EU orders skip the Belgian stock (batch 1 serves EU and INT, only the US is excluded)', () => {
    assert.doesNotMatch(copy.channel_eu_text, /outside the EU ship with the preorder batch/);
    assert.match(copy.channel_eu_text, /not the US/);
  });

  it('tells international buyers the Belgian FC and ESC stock ships to them', () => {
    assert.match(copy.channel_international_text, /stock in Belgium ships to your country/);
    assert.doesNotMatch(copy.channel_international_text, /^Orders to your country ship with the preorder batch/);
  });

  it('uses no em dash', () => {
    for (const k of ['channel_eu_text', 'channel_international_text']) {
      assert.ok(!copy[k].includes('—'), k);
    }
  });
});
