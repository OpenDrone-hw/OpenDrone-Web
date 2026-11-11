import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {bySku, catalogHasPreorders, withoutBuyNow, type Catalog} from './catalog.ts';
import {applyCampaign, parseCampaignConfig, type CampaignConfig} from './preorder-campaign.ts';
import {mapShopifyCatalog} from './shopify-storefront.ts';
import {choiceCatalogData, CHOICE_IDS, CHOICE_POLICY} from './batch-choice-fixture.ts';
import {regionFor} from './region.ts';
import {paidBatchMessage} from './shopify-cart-action.ts';
import {geoBarText, type GeoAvailabilityRegion} from './geo-availability.ts';

/**
 * The integration of the three PRs (batch 2 confirmed, buy now or pre-order,
 * regions): the offers a visitor sees follow `Region.lanes`, one region
 * answer for every surface.
 */

const CONFIG: CampaignConfig = {
  ...parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'))),
  choiceFrom: '2026-11-20T10:00:00Z',
};
const NOW = new Date('2026-11-21T12:00:00Z');
const FC = 'OPENFC-LITE-2020';

const live = (): Catalog =>
  applyCampaign(
    mapShopifyCatalog(choiceCatalogData(), 'open-drone-test.myshopify.com', JSON.stringify(CHOICE_POLICY), '1', 'default', true),
    CONFIG,
    {},
    NOW,
    'EU',
  );

describe('batch model: offers follow region.lanes', () => {
  it('Buy now lane only for a known EU country', () => {
    for (const [country, buyNow] of [['BE', true], ['DE', true], ['GB', false], ['CH', false], ['NO', false], ['US', false], ['CA', false], ['AU', false], [null, false]] as const) {
      assert.equal(regionFor(country, country ? 'geo' : 'default', true).lanes.buyNow, buyNow, String(country));
    }
  });

  it('an EU catalog read for a buyer without the lane holds no Buy now offer, only the pre-order', () => {
    const catalog = live();
    assert.equal(bySku(catalog, FC)!.variant.offer, 'buy_now', 'fixture: the EU catalog sells batch 1');
    const plain = withoutBuyNow(catalog);
    const variant = bySku(plain, FC)!.variant;
    assert.equal(variant.offer, 'preorder');
    assert.equal(variant.merchandise_id, CHOICE_IDS[FC].preorder);
    assert.equal(variant.preorder_offer, undefined);
    assert.equal(variant.price, bySku(catalog, FC)!.variant.preorder_offer!.price, 'the pre-order price, never retail');
    assert.ok(plain.products.every((p) => p.variants.every((v) => v.offer !== 'buy_now')));
    assert.equal(catalogHasPreorders(plain), true);
  });

  it('leaves a catalog without Buy now untouched (same object)', () => {
    const plain = withoutBuyNow(live());
    assert.equal(withoutBuyNow(plain), plain);
  });
});

describe('batch model: the ordinary shop names no batch', () => {
  it('the bar reads stock, never a pre-order or a batch month, in every region and locale', () => {
    for (const locale of ['en', 'nl', 'fr'] as const) {
      for (const region of ['eu', 'import', 'intl', 'us', 'fallback'] as GeoAvailabilityRegion[]) {
        for (const short of [false, true]) {
          const text = geoBarText(region, locale, short, true);
          assert.ok(text.length > 0);
          assert.doesNotMatch(text, /pre-?order|précommande|2027|march|maart|mars|batch/i, `${locale} ${region} ${short}`);
        }
      }
    }
  });
  it('the bar keeps the current lines while anything is pre-order', () => {
    assert.match(geoBarText('intl', 'en', false), /Pre-order/);
  });
});

describe('batch model: a country the shop cannot sell to', () => {
  it('the bar takes the buy box words, never a ship date (source guard)', () => {
    const layout = fs.readFileSync(new URL('../components/PageLayout.tsx', import.meta.url), 'utf8');
    assert.match(layout, /note=\{[^}]*notSoldNote\(/);
    const bar = fs.readFileSync(new URL('../components/AvailabilityBanner.tsx', import.meta.url), 'utf8');
    assert.equal((bar.match(/\{note \?\? geoBarText\(/g) ?? []).length, 2, 'long and phone line');
  });
  it('blocked and unreachable countries have neither lane', () => {
    for (const country of ['RU', 'KP', 'ZW', 'PR']) {
      const region = regionFor(country, 'geo', true);
      assert.deepEqual(region.lanes, {buyNow: false, preorder: false}, country);
      assert.equal(region.shipping.available, false, country);
    }
  });
});

describe('batch model: no funding condition left in customer words', () => {
  it('the paid-batch limit message names no target', () => {
    for (const left of [1, 5]) for (const inCart of [0, 2]) assert.doesNotMatch(paidBatchMessage(left, 'In stock in Belgium', inCart), /target|funding/i);
  });
});

describe('batch model: failures read as what they are', () => {
  const page = fs.readFileSync(new URL('../routes/products.$handle.tsx', import.meta.url), 'utf8');
  it('a refused Buy now explains itself even when the Buy now card is gone (source guard)', () => {
    assert.match(page, /\{expressRefusal && choiceOn \? <p className="cart-alert" role="alert">/);
    assert.doesNotMatch(page, /\{offerChoice && expressRefusal \?/);
  });
  it('a 503 (cart or catalog down a moment) shows its own message, not "unexpected error" (source guard)', () => {
    const root = fs.readFileSync(new URL('../root.tsx', import.meta.url), 'utf8');
    assert.match(root, /errorStatus === 503 && errorMessage \?/);
  });
});
