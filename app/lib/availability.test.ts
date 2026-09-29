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
import {campaignState, parseCampaignConfig, tiersFor} from './preorder-campaign.ts';
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
      ['Batch 1', 'EU only', 'current', '249 left'],
      ['March 2027 batch', 'EU and US', 'next', null],
    ]);
    assert.equal(rows[0].detail, 'Ships early Nov 2026 · Delivered by 30 Nov 2026');
    assert.equal(
      rows[1].detail,
      'Deadline 15 Dec 2026 · Ships by 31 Mar 2027 if the target is reached · Delivered by 15 Apr 2027',
    );
  });

  it('shows a US buyer batch 1 as not available to the US and the March batch selected', () => {
    const rows = availabilityRows(state('OPENESC-3030', 1, 'US'), DATES, 'US', words);
    assert.deepEqual(rows.map((r) => [r.label, r.state, r.note]), [
      ['Batch 1', 'other_region', 'Not available in the US'],
      ['March 2027 batch', 'current', null],
    ]);
    assert.match(rows[1].detail, /Delivered by 30 Apr 2027/);
  });

  it('marks a sold-out batch 1 and moves an EU buyer to the March batch', () => {
    const rows = availabilityRows(state('OPENESC-3030', 250, 'EU'), DATES, 'EU', words);
    assert.deepEqual(rows.map((r) => [r.state, r.note]), [['sold_out', 'Sold out'], ['current', null]]);
  });

  it('gives every other product one row: the March batch, EU and US', () => {
    for (const region of ['EU', 'US'] as const) {
      const rows = availabilityRows(state('OPENRX-LITE', 3, region), DATES, region, words);
      assert.equal(rows.length, 1, region);
      assert.deepEqual([rows[0].label, rows[0].scope, rows[0].state], ['March 2027 batch', 'EU and US', 'current']);
    }
  });

  it('names the batch a counter counts toward', () => {
    const eu = currentBatch(state('OPENESC-3030', 1, 'EU'))!;
    const us = currentBatch(state('OPENESC-3030', 1, 'US'))!;
    assert.equal(batchPhrase(eu, words), 'batch 1');
    assert.equal(batchPhrase(us, words), 'the March 2027 batch');
    assert.equal(batchLabel(us, words), 'March 2027 batch');
  });

  it('uses one wording for the cart line and the checkout line property', () => {
    assert.equal(batchText(state('OPENESC-3030', 1, 'EU'), words), 'Batch 1 · EU only');
    assert.equal(batchText(state('OPENESC-3030', 1, 'US'), words), 'March 2027 batch · EU and US');
    const variant = (campaign: ReturnType<typeof state>): CatalogVariant => ({
      sku: 'OPENESC-3030', title: 'x', model: null, options: {}, price: 47.2, compare_price: 59, currency: 'EUR',
      availability: 'preorder', ship_promise: campaign.shipPromise, campaign, image: null, url: '/products/openesc',
      cart_add_url: '/api/shopify/cart', merchandise_id: 'gid://shopify/ProductVariant/1',
    });
    const attrs = (v: CatalogVariant, us: boolean) =>
      Object.fromEntries((lineAttributes(v, us) ?? []).map((a) => [a.key, a.value]));
    assert.equal(attrs(variant(state('OPENESC-3030', 1, 'EU')), false).Availability, 'Batch 1 · EU only');
    const us = attrs(variant(state('OPENESC-3030', 1, 'US')), true);
    assert.equal(us.Availability, 'March 2027 batch · EU and US');
    assert.equal(us._ship_region, 'US');
  });
});
