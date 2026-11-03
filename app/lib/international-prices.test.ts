import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import type {Catalog} from './catalog.ts';
import {applyCampaign, campaignState, internationalRegion, isInternationalRegion, parseCampaignConfig, regionOf, type Region} from './preorder-campaign.ts';
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

test('regions: GB, CH and NO are NEAR, every other non-EU, non-US country INT', () => {
  for (const country of ['GB', 'CH', 'NO', 'gb', ' ch ']) assert.equal(regionOf(country), 'NEAR', country);
  for (const country of ['CA', 'AU', 'JP', 'IS', 'LI']) assert.equal(regionOf(country), 'INT', country);
  assert.equal(regionOf('BE'), 'EU');
  assert.equal(regionOf('US'), 'US');
  assert.equal(regionOf(null), 'EU');
  for (const country of ['GB', 'CH', 'NO']) assert.equal(internationalRegion(country), 'NEAR', country);
  for (const country of ['CA', 'JP', null]) assert.equal(internationalRegion(country), 'INT', String(country));
  assert.deepEqual(['EU', 'US', 'NEAR', 'INT'].map((r) => isInternationalRegion(r as Region)), [false, false, true, true]);
});

test('NEAR destinations (GB, CH, NO) take the March batch, never batch 1 FC stock or the Belgian accessory inventory', () => {
  const campaign = applyCampaign(base, config, {}, new Date('2026-10-01'), 'NEAR');
  for (const variant of campaign.products[0].variants) {
    assert.equal(variant.availability, 'preorder', variant.sku);
    assert.equal(variant.campaign?.batch, 2, variant.sku);
    assert.equal(variant.campaign?.paidStock, false, variant.sku);
    assert.equal(variant.campaign?.deliveryByDay, '2027-04-30', variant.sku);
    assert.match(variant.ship_promise ?? '', /31 March 2027/);
    assert.doesNotMatch(variant.ship_promise ?? '', /late November|15 April|30 April/);
  }
});

test('INT destinations take the March batch, never batch 1 FC stock or the Belgian accessory inventory', () => {
  const campaign = applyCampaign(base, config, {}, new Date('2026-10-01'), 'INT');
  for (const variant of campaign.products[0].variants) {
    assert.equal(variant.availability, 'preorder', variant.sku);
    assert.equal(variant.campaign?.batch, 2, variant.sku);
    assert.equal(variant.campaign?.paidStock, false, variant.sku);
    assert.equal(variant.campaign?.deliveryByDay, '2027-04-30', variant.sku);
    assert.match(variant.ship_promise ?? '', /31 March 2027/);
    assert.doesNotMatch(variant.ship_promise ?? '', /late November|15 April|30 April/);
  }
});

test('only EU units fill batch 1; NEAR, INT and US units go to the funding target', () => {
  const ordered = [{region: 'INT', units: 3}, {region: 'NEAR', units: 4}, {region: 'US', units: 2}, {region: 'EU', units: 5}] as const;
  const eu = campaignState(config.skus['OPENFC-LITE-2020'].batches, [...ordered], config.pendingShips, [], null, 'EU');
  assert.equal(eu.batch, 1);
  assert.equal(eu.paidLeft, 195); // 200 sellable (250 less 50 reserved, to be confirmed) less the 5 EU units
  assert.equal(eu.targetOrdered, 9); // the 3 INT, 4 NEAR and 2 US units
  for (const region of ['NEAR', 'INT'] as const) {
    const state = campaignState(config.skus['OPENFC-LITE-2020'].batches, [...ordered], config.pendingShips, [], null, region);
    assert.equal(state.batch, 2, region);
    assert.equal(state.paidStock, false, region);
    assert.equal(state.deliveryByDay, '2027-04-30', region);
  }
});

test('country prices are copied exactly, without US uplift or an inferred local ladder', () => {
  for (const [region, currencies] of [['INT', ['CAD', 'AUD', 'EUR']], ['NEAR', ['CHF', 'GBP', 'NOK']]] as const) {
  const campaign = applyCampaign(base, config, {}, new Date('2026-10-01'), region);
  for (const currency of currencies) {
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
      // Batch 1 is EU only: NEAR and INT both take the March batch.
      assert.equal(variant.campaign?.batch, 2, `${region} ${variant.sku}`);
    }
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
  // Batch 1 is EU only and Belgian stock: no delivery date and no Preorder line for it, the promise hidden.
  // NEAR and INT always take the March international date, however empty batch 1 is.
  for (const [region, units, date] of [['EU',0,undefined],['EU',250,'15 April 2027'],['NEAR',0,'30 April 2027'],['NEAR',250,'30 April 2027'],['INT',0,'30 April 2027'],['INT',250,'30 April 2027']] as const) {
    const catalog=applyCampaign(priced,config,{'OPENFC-LITE-2020':units},new Date('2026-10-01'),region);
    const variant=catalog.products.flatMap(p=>p.variants).find(v=>v.sku==='OPENFC-LITE-2020')!;
    const attributes=lineAttributes(variant,region)!;
    const stock=region==='EU'&&units===0;
    assert.equal(attributes.find(a=>a.key==='Delivery by')?.value,date);
    assert.equal(attributes.find(a=>a.key===(stock?'_ship_promise':'Preorder'))?.value,variant.ship_promise);
    assert.equal(attributes.find(a=>a.key==='Preorder')?.value,stock?undefined:variant.ship_promise);
    assert.equal(attributes.find(a=>a.key==='Shipping')?.value,stock?'In stock in Belgium, ships in a few days.':undefined);
    // Only NEAR lines tell the buyer they pay import VAT and duties on delivery.
    assert.equal(attributes.find(a=>a.key==='Import VAT and duties')?.value,region==='NEAR' ? 'Paid by you on delivery, unless collected at checkout' : undefined,region);
    assert.doesNotMatch(variant.ship_promise??'',/delivered|30 April|15 April/);
  }
});

test('EU batch 1 cart lines say in stock in Belgium with no preorder date; NEAR and INT take the March batch, US unchanged', () => {
  const priced = {...base,products:base.products.map(p=>({...p,variants:p.variants.map(v=>({...v,price:25,availability:v.sku==='OPENFC-LITE-2020' ? 'preorder' as const : v.availability}))}))};
  const attrs = (region: 'EU' | 'NEAR' | 'INT' | 'US') => {
    const catalog=applyCampaign(priced,config,{},new Date('2026-10-01'),region);
    const variant=catalog.products.flatMap(p=>p.variants).find(v=>v.sku==='OPENFC-LITE-2020')!;
    return lineAttributes(variant,region)!;
  };
  const eu = attrs('EU');
  assert.deepEqual(eu, [
    {key: 'Shipping', value: 'In stock in Belgium, ships in a few days.'},
    {key: '_ship_promise', value: 'ships late November 2026'},
    {key: '_batch', value: 'OPENFC-LITE-2020:1'},
  ]);
  // Nothing visible (no leading underscore) says preorder or names the November date.
  for (const a of eu.filter((x) => !x.key.startsWith('_'))) {
    assert.doesNotMatch(`${a.key}: ${a.value}`, /preorder|30 November|late November/i);
  }
  // Batch 1 is EU only (paidRegions): INT and NEAR take the March batch.
  assert.deepEqual(attrs('INT'), [
    {key: 'Preorder', value: config.pendingShips},
    {key: 'Delivery by', value: '30 April 2027'},
    {key: '_ship_region', value: 'INT'},
    {key: '_batch', value: 'OPENFC-LITE-2020:2'},
  ]);
  assert.deepEqual(attrs('NEAR'), [
    {key: 'Preorder', value: config.pendingShips},
    {key: 'Delivery by', value: '30 April 2027'},
    {key: '_ship_region', value: 'NEAR'},
    {key: 'Import VAT and duties', value: 'Paid by you on delivery, unless collected at checkout'},
    {key: '_batch', value: 'OPENFC-LITE-2020:2'},
  ]);
  assert.deepEqual(attrs('US'), [
    {key: 'Preorder', value: config.pendingShips},
    {key: 'Delivery by', value: '30 April 2027'},
    {key: '_ship_region', value: 'US'},
    {key: '_batch', value: 'OPENFC-LITE-2020:2'},
  ]);
});
