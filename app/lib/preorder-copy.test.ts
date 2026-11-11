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
  // batch with import VAT and duties on delivery. The US line is not in this
  // text: it follows the PUBLIC_US_SALES gate (geo-availability.ts).
  it('EU text: Belgian stock ships to EU addresses, outside the EU the March 2027 batch, no US claim', () => {
    assert.match(copy.channel_eu_text, /stock in Belgium ships to EU addresses/);
    assert.match(copy.channel_eu_text, /Outside the EU, orders ship with the March 2027 preorder batch/);
    assert.doesNotMatch(copy.channel_eu_text, /\bUS\b/);
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

describe('batch 1 stock on /preorder', () => {
  const route = readFileSync(new URL('../routes/preorder.tsx', import.meta.url), 'utf8');
  it('reads as stock for a visitor whose region gets it as stock, like the bar and the product page', () => {
    assert.match(route, /useGeoInStock\(null, data\.stackPromise\)/);
    assert.match(route, /stockNow\?\.line \?\? shipWord\('ships', stackWhen \?\? stackMonth\)/);
  });
  it('has a parcel line without a ship month for that visitor', () => {
    assert.match(copy.targets_line_stock, /^One order ships in one parcel, when its last item is ready\./);
    assert.doesNotMatch(copy.targets_line_stock, /\{month\}/);
    assert.ok(copy.targets_line.startsWith('One order ships in one parcel, when its last item is ready.'));
  });
});
