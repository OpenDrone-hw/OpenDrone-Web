import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Run with:
//   node --experimental-strip-types --test app/lib/preorder-copy.test.ts

const copy = JSON.parse(
  readFileSync(new URL('../../content/copy/preorder.json', import.meta.url), 'utf8'),
) as Record<string, string>;

describe('/preorder channel copy', () => {
  // Founder 2026-11-03: Belgian FC/ESC stock (batch 1) ships to EU addresses
  // only; every non-EU destination, UK/CH/NO included, gets the March 2027
  // batch with import VAT and duties on delivery; the US is not sold yet.
  it('EU text: Belgian stock ships to EU addresses, outside the EU the March 2027 batch, not the US yet', () => {
    assert.match(copy.channel_eu_text, /stock in Belgium ships to EU addresses/);
    assert.match(copy.channel_eu_text, /Outside the EU, orders ship with the March 2027 preorder batch/);
    assert.match(copy.channel_eu_text, /Not shipping to the US yet/);
  });

  it('international text: March 2027 batch with the duties note, never Belgian stock or November for non-EU', () => {
    const text = copy.channel_international_text;
    assert.match(text, /stock in Belgium ships to EU addresses only/);
    assert.match(text, /Outside the EU, everything ships with the March 2027 preorder batch/);
    assert.match(text, /Import VAT, duties and customs fees are paid by you on delivery, unless collected at checkout/);
    assert.doesNotMatch(text, /ships to your country/);
    assert.doesNotMatch(text, /November/i);
    assert.doesNotMatch(text, /UK|United Kingdom|Switzerland|Norway/);
  });

  it('no channel text promises Belgian stock or a November date outside the EU, or US shipping', () => {
    for (const k of ['channel_eu_text', 'channel_international_text']) {
      assert.doesNotMatch(copy[k], /(international|your country|UK|Switzerland|Norway)[^.]*(stock|November)/i, k);
      assert.doesNotMatch(copy[k], /ships? to the US(?! yet)/, k);
    }
  });

  it('uses no em dash', () => {
    for (const k of ['channel_eu_text', 'channel_international_text']) {
      assert.ok(!copy[k].includes('—'), k);
    }
  });
});
