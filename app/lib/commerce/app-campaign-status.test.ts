import assert from 'node:assert/strict';
import {test} from 'node:test';
import {appCampaignStatus} from './app-campaign-status.ts';
import type {Catalog} from '../catalog.ts';

const cat = (mode: string, counts?: 'verified' | 'unavailable', ordered = 7) =>
  ({
    campaign_counts: counts,
    products: [{variants: [{sku: 'A', availability: mode, campaign: {ordered}}, {sku: 'X', availability: 'sold_out'}]}],
  }) as unknown as Catalog;

test('open preorder SKU reports its count from the app', () => {
  const s = appCampaignStatus(cat('preorder', 'verified'), null, ['A']);
  assert.equal(s.allOpen, true);
  assert.deepEqual(s.skus.A, {open: true, availability: 'preorder', ordered: 7});
  assert.equal(s.paidCounts.ok, true);
  assert.equal(s.catalog.countsVerified, true);
});

test('a sold out SKU is not open', () => {
  assert.equal(appCampaignStatus(cat('sold_out', 'verified'), null, ['A']).allOpen, false);
});

test('the app not answering: nothing open, error kept', () => {
  const s = appCampaignStatus(null, 'app: unreachable', ['A']);
  assert.equal(s.allOpen, false);
  assert.equal(s.catalog.ok, false);
  assert.equal(s.paidCounts.ok, false);
  assert.equal(s.skus.A.availability, 'not on the storefront');
});

test('counts the app could not read show in paidCounts', () => {
  const s = appCampaignStatus(cat('preorder', 'unavailable'), null, ['A']);
  assert.equal(s.paidCounts.ok, false);
  assert.equal(s.catalog.countsVerified, false);
});
