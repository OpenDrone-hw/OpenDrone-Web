import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {
  availabilityRows,
  batchLabel,
  batchPhrase,
  batchText,
  currentBatch,
  targetDates,
} from './availability.ts';
import {campaignState, parseCampaignConfig, shipsWithState, tiersFor} from './preorder-campaign.ts';
import {serverPreorderWords as words} from './preorder-words.ts';
import {lineAttributes} from './shopify-cart-action.ts';
import type {CatalogVariant} from './catalog.ts';

const REAL = parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')));
const DATES = targetDates('15 December 2026', '31 March 2027');

function state(sku: string, ordered: number, region: 'EU' | 'US') {
  const entry = REAL.skus[sku];
  return campaignState(entry.batches, ordered, REAL.pendingShips, tiersFor(REAL, sku), 59, region);
}

describe('availability block', () => {
  it('lists both FC/ESC batches for an EU buyer, batch 1 highlighted with its units left', () => {
    const rows = availabilityRows(state('OPENESC-3030', 1, 'EU'), DATES, 'EU', words);
    assert.deepEqual(rows.map((r) => [r.label, r.scope, r.state, r.note]), [
      ['From Belgium', 'EU addresses only', 'current', '249 left'],
      ['March 2027 batch', 'EU, US and more', 'next', null],
    ]);
    assert.equal(rows[0].detail, 'Ships early Nov 2026');
    assert.equal(
      rows[1].detail,
      'Target deadline 15 Dec 2026 · Ships by 31 Mar 2027 if the target is reached',
    );
  });

  it('shows a US buyer batch 1 as not available to the US and the March batch selected', () => {
    const rows = availabilityRows(state('OPENESC-3030', 1, 'US'), DATES, 'US', words);
    // Chronological in every region; the buyer's batch is the current one.
    assert.deepEqual(rows.map((r) => [r.label, r.state, r.note]), [
      ['From Belgium', 'other_region', 'Not available in the US'],
      ['March 2027 batch', 'current', null],
    ]);
    assert.doesNotMatch(rows[1].detail, /deliver/i);
  });

  it('marks a sold-out batch 1 and moves an EU buyer to the March batch', () => {
    const rows = availabilityRows(state('OPENESC-3030', 250, 'EU'), DATES, 'EU', words);
    assert.deepEqual(rows.map((r) => [r.state, r.note]), [['sold_out', 'Sold out'], ['current', null]]);
  });

  it('gives every other product one row: the March batch, International preorders', () => {
    for (const region of ['EU', 'US'] as const) {
      const rows = availabilityRows(state('OPENRX-LITE', 3, region), DATES, region, words);
      assert.equal(rows.length, 1, region);
      assert.deepEqual([rows[0].label, rows[0].scope, rows[0].state], ['March 2027 batch', 'EU, US and more', 'current']);
    }
  });

  it('names the batch a counter counts toward', () => {
    const eu = currentBatch(state('OPENESC-3030', 1, 'EU'))!;
    const us = currentBatch(state('OPENESC-3030', 1, 'US'))!;
    assert.equal(batchPhrase(eu, words), 'the EU stock');
    assert.equal(batchPhrase(us, words), 'the March 2027 batch');
    assert.equal(batchLabel(us, words), 'March 2027 batch');
  });

  it('names the batch on the product page and leaves it off the checkout line properties', () => {
    assert.equal(batchText(state('OPENESC-3030', 1, 'EU'), words), 'From Belgium · EU addresses only');
    assert.equal(batchText(state('OPENESC-3030', 1, 'US'), words), 'March 2027 batch · EU, US and more');
    const variant = (campaign: ReturnType<typeof state>): CatalogVariant => ({
      sku: 'OPENESC-3030', title: 'x', model: null, options: {}, price: 47.2, compare_price: 59, currency: 'EUR',
      availability: 'preorder', ship_promise: campaign.shipPromise, campaign, image: null, url: '/products/openesc',
      cart_add_url: '/api/shopify/cart', merchandise_id: 'gid://shopify/ProductVariant/1',
    });
    const attrs = (v: CatalogVariant, us: boolean) =>
      Object.fromEntries((lineAttributes(v, us) ?? []).map((a) => [a.key, a.value]));
    assert.equal(attrs(variant(state('OPENESC-3030', 1, 'EU')), false).Availability, undefined);
    const us = attrs(variant(state('OPENESC-3030', 1, 'US')), true);
    assert.equal(us.Availability, undefined);
    assert.equal(us._ship_region, 'US');
  });
});

/** The state of an accessory that ships with the FC (`shipsWith`), for a buyer. */
function accessory(sku: string, region: 'EU' | 'US', own = 0) {
  return shipsWithState(REAL, REAL.shipsWith![sku], 1, 6.9, own, region);
}

describe('one name for the November batch (G1)', () => {
  const NAME = 'From Belgium · EU addresses only';

  it('names the FC/ESC batch and the accessories that ship with it the same', () => {
    assert.equal(batchText(state('OPENESC-3030', 1, 'EU'), words), NAME);
    for (const sku of ['ACC-STRAP-20X220', 'ACC-CAP-470UF-35V', 'ACC-CAP-470UF-50V', 'ACC-ANT-T', 'ACC-ANT-DUAL-T']) {
      assert.equal(batchText(accessory(sku, 'EU'), words), NAME, sku);
      assert.equal(batchLabel(currentBatch(accessory(sku, 'EU'))!, words), 'From Belgium', sku);
    }
  });

  it('never calls the November batch "November 2026 batch"', () => {
    for (const sku of Object.keys(REAL.shipsWith!)) {
      for (const region of ['EU', 'US'] as const) {
        const text = batchText(accessory(sku, region), words);
        assert.doesNotMatch(text ?? '', /November 2026 batch/, `${sku} ${region}`);
      }
    }
  });

  it('lists the March batch after Batch 1 for an EU buyer of stocked accessories, as for a US buyer', () => {
    for (const sku of ['ACC-ANT-T', 'ACC-CAP-470UF-35V']) {
      const eu = availabilityRows(accessory(sku, 'EU'), DATES, 'EU', words);
      assert.deepEqual(eu.map((r) => [r.label, r.state]), [
        ['From Belgium', 'current'],
        ['Ships with the OpenFC Lite March 2027 batch', 'next'],
      ], sku);
    }
  });

  it('gives the accessory the same rows and "EU only" as the FC, with Batch 1 first, then the March batch, for a US buyer', () => {
    const eu = availabilityRows(accessory('ACC-STRAP-20X220', 'EU'), DATES, 'EU', words);
    assert.deepEqual(eu.map((r) => [r.label, r.scope, r.state]), [['From Belgium', 'EU addresses only', 'current']]);
    assert.equal(eu[0].detail, 'Ships early Nov 2026');
    for (const sku of ['ACC-STRAP-20X220', 'ACC-ANT-T', 'ACC-CAP-470UF-35V']) {
      const us = availabilityRows(accessory(sku, 'US'), DATES, 'US', words);
      // G7: the accessory has no target of its own, so it names the lead's.
      assert.deepEqual(us.map((r) => [r.label, r.state, r.note]), [
        ['From Belgium', 'other_region', 'Not available in the US'],
        ['Ships with the OpenFC Lite March 2027 batch', 'current', null],
      ], sku);
      assert.match(us[1].detail, /Ships by 31 Mar 2027 if that target is reached/, sku);
      assert.equal(batchText(accessory(sku, 'US'), words), 'Ships with the OpenFC Lite March 2027 batch · EU, US and more', sku);
    }
  });

  it('counts an accessory\'s own stock, not the FC\'s units, in "left"', () => {
    const rows = availabilityRows(accessory('ACC-ANT-T', 'EU', 10), DATES, 'EU', words);
    assert.equal(rows[0].note, '90 left');
    assert.equal(availabilityRows(accessory('ACC-STRAP-20X220', 'EU'), DATES, 'EU', words)[0].note, null);
  });
});

describe('a batch name never carries a date (G6, G8)', () => {
  const skus = [...Object.keys(REAL.skus), ...Object.keys(REAL.shipsWith!)];
  const campaigns = (region: 'EU' | 'US') =>
    skus.flatMap((sku) => {
      try {
        return [[sku, REAL.shipsWith?.[sku] ? accessory(sku, region) : state(sku, 1, region)] as const];
      } catch {
        return [];
      }
    });

  it('has no month, year or "ships" in the batch text of any SKU, EU or US', () => {
    for (const region of ['EU', 'US'] as const) {
      for (const [sku, campaign] of campaigns(region)) {
        const text = batchText(campaign, words) ?? '';
        assert.doesNotMatch(text, /\bships (early|mid|late|by|in)\b|\b(Nov|Dec|Jan|Feb)\b|2026\b/i, `${sku} ${region}: ${text}`);
      }
    }
  });

  it('names every accessory that waits for a lead target with the lead, International preorders', () => {
    for (const region of ['EU', 'US'] as const) {
      for (const [sku, campaign] of campaigns(region)) {
        if (!REAL.shipsWith?.[sku]) continue;
        const current = currentBatch(campaign)!;
        const text = batchText(campaign, words)!;
        if (current.paid) assert.equal(text, 'From Belgium · EU addresses only', `${sku} ${region}`);
        else assert.match(text, /^Ships with the (OpenFC Lite|OpenFrame) March 2027 batch · EU, US and more$/, `${sku} ${region}`);
      }
    }
  });

  it('gives each line of a mixed EU cart its own date in the checkout properties and no batch name', () => {
    const variant = (sku: string, campaign: ReturnType<typeof state>): CatalogVariant => ({
      sku, title: 'x', model: null, options: {}, price: 47.2, compare_price: 59, currency: 'EUR',
      availability: 'preorder', ship_promise: campaign.shipPromise, campaign, image: null, url: '/products/x',
      cart_add_url: '/api/shopify/cart', merchandise_id: `gid://shopify/ProductVariant/${sku}`,
    });
    const attrs = (v: CatalogVariant) => Object.fromEntries((lineAttributes(v, false) ?? []).map((a) => [a.key, a.value]));
    const nov = attrs(variant('OPENESC-3030', state('OPENESC-3030', 1, 'EU')));
    const march = attrs(variant('OPENRX-LITE', state('OPENRX-LITE', 1, 'EU')));
    // The date lives in `Preorder` only.
    assert.equal(nov.Availability, undefined);
    assert.equal(march.Availability, undefined);
    assert.match(nov.Preorder, /early November 2026/);
  });
});
