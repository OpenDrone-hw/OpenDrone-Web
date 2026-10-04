import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import type {Catalog} from './catalog.ts';
import {applyCampaign, campaignState, parseCampaignConfig, regionOf} from './preorder-campaign.ts';
import {withInternationalPrices} from './international-prices.ts';
import {lineAttributes} from './shopify-cart-action.ts';

const config = parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')));
const base: Catalog = {
  schema: 1, generated_at: '', max_age: 0, currency: 'EUR', prices_include_vat: true,
  shop_url: 'https://example.myshopify.com', cart_url: '/cart', add_url: '/api/shopify/cart',
  products: [{
    handle: 'openfc-lite', title: 'OpenFC Lite', family: null, description: null, url: '/products/openfc-lite', images: [], rating: null,
    variants: ['OPENFC-LITE-2020', 'ACC-CAP-470UF-35V', 'OTHER-ACCESSORY'].map((sku) => ({
      sku, title: sku, model: null, options: {}, price: 20, compare_price: 25, currency: 'EUR',
      availability: 'in_stock', ship_promise: null, image: null, url: '/products/openfc-lite', cart_add_url: '/api/shopify/cart',
    })),
  }],
};

test('international destinations never consume Belgian paid stock or its accessory inventory', () => {
  for (const country of ['GB', 'CH', 'NO', 'CA', 'AU', 'JP']) assert.equal(regionOf(country), 'INT');
  assert.equal(regionOf('BE'), 'EU');
  assert.equal(regionOf('US'), 'US');
  assert.equal(regionOf(null), 'EU');
  const campaign = applyCampaign(base, config, {}, new Date('2026-10-01'), 'INT');
  for (const variant of campaign.products[0].variants) {
    assert.equal(variant.availability, 'preorder', variant.sku);
    assert.equal(variant.campaign?.batch, 2, variant.sku);
    assert.equal(variant.campaign?.paidStock, false, variant.sku);
    assert.equal(variant.campaign?.deliveryByDay, '2027-04-30', variant.sku);
    assert.match(variant.ship_promise ?? '', /31 March 2027/);
    assert.doesNotMatch(variant.ship_promise ?? '', /early November|15 April|30 April/);
  }
  const eu = campaignState(config.skus['OPENFC-LITE-2020'].batches, [{region:'INT', units:3}, {region:'US', units:2}], config.pendingShips, [], null, 'EU');
  assert.equal(eu.batch, 1);
  assert.equal(eu.paidLeft, 225);
  assert.equal(eu.targetOrdered, 5);
});

test('country prices are copied exactly, without US uplift or an inferred local ladder', () => {
  const campaign = applyCampaign(base, config, {}, new Date('2026-10-01'), 'INT');
  for (const currency of ['CAD', 'AUD', 'CHF', 'GBP', 'EUR']) {
    const market = {...base, currency, products: base.products.map(p => ({...p, variants: p.variants.map(v => ({...v, price:31.42, compare_price:40.16, currency}))}))};
    const result = withInternationalPrices(campaign, market);
    assert.equal(result.currency, currency);
    for (const variant of result.products[0].variants) {
      assert.equal(variant.price, 31.42);
      assert.equal(variant.compare_price, 40.16);
      assert.equal(variant.campaign?.price, 31.42);
      assert.equal(variant.campaign?.nextPrice, null);
      assert.equal(variant.campaign?.usLadder, undefined);
      assert.equal(variant.campaign?.internationalPrice, true);
      assert.equal(variant.campaign?.batch, 2);
    }
  }
});

test('missing country prices or denied variants close that destination without inventing a price', () => {
  const campaign = applyCampaign(base, config, {}, new Date('2026-10-01'), 'INT');
  assert.ok(withInternationalPrices(campaign, null).products[0].variants.every(v => v.availability === 'sold_out'));
  const market: Catalog = {...base, products:[{...base.products[0], variants:[{...base.products[0].variants[0], availability:'sold_out'}]}]};
  assert.ok(withInternationalPrices(campaign, market).products[0].variants.every(v => v.availability === 'sold_out'));
});

test('an international arrival date must be supplied separately from existing EU and US dates', () => {
  const batches = [{units:10, deliveryBy:'2027-04-15', deliveryByUS:'2027-04-30'}];
  assert.equal(campaignState(batches,0,config.pendingShips,[],null,'INT').deliveryByDay,null);
  assert.equal(campaignState([{...batches[0], deliveryByINT:'2027-05-15'}],0,config.pendingShips,[],null,'INT').deliveryByDay,'2027-05-15');
});


test('checkout states distinct paid-stock, EU funding and international arrival deadlines without changing dispatch promises', () => {
  const priced = {...base,products:base.products.map(p=>({...p,variants:p.variants.map(v=>({...v,price:25,availability:v.sku==='OPENFC-LITE-2020' ? 'preorder' as const : v.availability}))}))};
  for (const [region, units, date] of [['EU',0,'30 November 2026'],['EU',250,'15 April 2027'],['INT',0,'30 April 2027']] as const) {
    const catalog=applyCampaign(priced,config,{'OPENFC-LITE-2020':units},new Date('2026-10-01'),region);
    const variant=catalog.products.flatMap(p=>p.variants).find(v=>v.sku==='OPENFC-LITE-2020')!;
    const attributes=lineAttributes(variant,region)!;
    assert.equal(attributes.find(a=>a.key==='Delivery by')?.value,date);
    assert.equal(attributes.find(a=>a.key==='Preorder')?.value,variant.ship_promise);
    assert.doesNotMatch(variant.ship_promise??'',/delivered|30 April|15 April/);
  }
});
