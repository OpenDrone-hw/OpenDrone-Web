import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {
  applyCampaign,
  campaignState,
  needsCampaignCounts,
  parseCampaignConfig,
  type CampaignBatch,
} from './preorder-campaign.ts';

const PENDING = 'ships about 10 weeks after its target is reached';
const STACK: CampaignBatch[] = [
  {units: 250, paid: true, ships: 'ships late October 2026'},
  {units: 250},
];
const FRAME: CampaignBatch[] = [{units: 250}, {units: 1000}];
const EARLY = 250;

describe('campaignState', () => {
  it('lists sold-out batches, the current one and the next', () => {
    const s = campaignState(STACK, 260, PENDING, EARLY);
    assert.deepEqual(
      s.batches.map(({batch, status, shipPromise}) => [batch, status, shipPromise]),
      [[1, 'sold_out', 'ships late October 2026'], [2, 'current', PENDING]],
    );
    assert.deepEqual(campaignState(FRAME, 0, PENDING, EARLY).batches.map((b) => b.status), ['current', 'next']);
  });

  it('sells paid stock with its own ship date and no early price', () => {
    const s = campaignState(STACK, 107, PENDING, EARLY);
    assert.equal(s.batch, 1);
    assert.equal(s.paidStock, true);
    assert.equal(s.batchOrdered, 107);
    assert.equal(s.batchUnits, 250);
    assert.equal(s.shipPromise, 'ships late October 2026');
    assert.equal(s.earlyPrice, true);
    assert.equal(s.target, 250);
    assert.equal(s.targetOrdered, 0);
  });

  it('moves the stack onto its funding target once paid stock is gone', () => {
    const s = campaignState(STACK, 250, PENDING, EARLY);
    assert.equal(s.batch, 2);
    assert.equal(s.paidStock, false);
    assert.equal(s.batchOrdered, 0);
    assert.equal(s.shipPromise, PENDING);
    assert.equal(s.earlyPrice, false);
    assert.equal(s.targetReached, false);
  });

  it('sells the first earlyUnits at the early price, whatever the batches', () => {
    const s = campaignState(FRAME, 187, PENDING, EARLY);
    assert.equal(s.earlyPrice, true);
    assert.equal(s.earlyUnits, 250);
    assert.equal(s.earlyLeft, 63);
    const after = campaignState(STACK, 260, PENDING, EARLY);
    assert.equal(after.earlyPrice, false);
    assert.equal(after.earlyLeft, 0);
    assert.equal(campaignState(FRAME, 0, PENDING, 0).earlyPrice, false);
  });

  it('counts toward the first target with the early price', () => {
    const s = campaignState(FRAME, 187, PENDING, EARLY);
    assert.equal(s.batch, 1);
    assert.equal(s.target, 250);
    assert.equal(s.targetOrdered, 187);
    assert.equal(s.targetReached, false);
    assert.equal(s.earlyPrice, true);
    assert.equal(s.shipPromise, PENDING);
  });

  it('reaches the target exactly at its unit count and opens the stretch batch', () => {
    const s = campaignState(FRAME, 250, PENDING, EARLY);
    assert.equal(s.targetReached, true);
    assert.equal(s.targetOrdered, 250);
    assert.equal(s.batch, 2);
    assert.equal(s.batchOrdered, 0);
    assert.equal(s.batchUnits, 1000);
    assert.equal(s.earlyPrice, false);
  });

  it('uses a batch ship promise once its supplier order is placed', () => {
    const placed: CampaignBatch[] = [{units: 250, ships: 'ships mid-December 2026'}, {units: 1000}];
    assert.equal(campaignState(placed, 10, PENDING, EARLY).shipPromise, 'ships mid-December 2026');
    assert.equal(campaignState(placed, 300, PENDING, EARLY).shipPromise, PENDING);
  });

  it('repeats the last batch size past the configured batches', () => {
    const s = campaignState(FRAME, 1250 + 1000 + 3, PENDING, EARLY);
    assert.equal(s.batch, 4);
    assert.equal(s.batchUnits, 1000);
    assert.equal(s.batchOrdered, 3);
  });

  it('treats a negative or non-finite count as zero', () => {
    assert.equal(campaignState(FRAME, -5, PENDING, EARLY).ordered, 0);
    assert.equal(campaignState(FRAME, Number.NaN, PENDING, EARLY).ordered, 0);
  });

  it('has no target when every batch is paid stock', () => {
    const s = campaignState([{units: 10, paid: true, ships: 'ships now'}], 3, PENDING, EARLY);
    assert.equal(s.target, null);
    assert.equal(s.targetReached, false);
    assert.equal(s.earlyPrice, true);
  });
});

describe('parseCampaignConfig', () => {
  it('accepts the committed config', () => {
    const config = parseCampaignConfig(
      JSON.parse(
        fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'),
      ),
    );
    assert.ok(Object.keys(config.skus).length > 0);
  });

  it('rejects a paid batch without a ship promise', () => {
    assert.throws(
      () =>
        parseCampaignConfig({
          countFrom: '2026-09-21', endsOn: '2026-12-31', earlyUnits: EARLY,
          pendingShips: PENDING,
          skus: {A: {batches: [{units: 1, paid: true}]}},
        }),
      /paid batch needs a ship promise/,
    );
  });

  it('rejects a missing or negative earlyUnits', () => {
    for (const earlyUnits of [undefined, -1, 2.5]) {
      assert.throws(
        () =>
          parseCampaignConfig({
            countFrom: '2026-09-21', endsOn: '2026-12-31', earlyUnits,
            pendingShips: PENDING,
            skus: {A: {batches: [{units: 1}]}},
          }),
        /earlyUnits/,
      );
    }
  });

  it('rejects a batch without positive units', () => {
    assert.throws(
      () =>
        parseCampaignConfig({
          countFrom: '2026-09-21', endsOn: '2026-12-31', earlyUnits: EARLY,
          pendingShips: PENDING,
          skus: {A: {batches: [{units: 0}]}},
        }),
      /positive units/,
    );
  });
});

function catalog(availability: 'preorder' | 'sold_out' | 'in_stock'): Catalog {
  return {
    schema: 1,
    generated_at: '2026-09-21T00:00:00Z',
    max_age: 300,
    currency: 'EUR',
    prices_include_vat: true,
    shop_url: 'https://store.myshopify.com',
    cart_url: 'https://store.myshopify.com',
    add_url: '/api/shopify/cart',
    products: [
      {
        handle: 'openframe',
        title: 'OpenFrame',
        family: null,
        description: null,
        url: '/products/openframe',
        images: [],
        rating: null,
        variants: [
          {
            sku: 'OPENFRAME-5',
            title: '5 inch',
            model: null,
            options: {},
            price: 79,
            compare_price: 99,
            currency: 'EUR',
            availability,
            ship_promise: null,
            image: null,
            url: '/products/openframe',
            cart_add_url: '/api/shopify/cart?sku=OPENFRAME-5&qty=1',
          },
          {
            sku: 'ACC-STRAP-20X220',
            title: 'Strap',
            model: null,
            options: {},
            price: 2,
            compare_price: null,
            currency: 'EUR',
            availability,
            ship_promise: 'ships in about 10 weeks',
            image: null,
            url: '/products/openframe',
            cart_add_url: '/api/shopify/cart?sku=ACC-STRAP-20X220&qty=1',
          },
        ],
      },
    ],
  };
}

const CONFIG = {countFrom: '2026-09-21', endsOn: '2026-12-31', earlyUnits: EARLY, pendingShips: PENDING, skus: {'OPENFRAME-5': {batches: FRAME}}};

describe('applyCampaign', () => {
  it('sets the campaign state and ship promise on campaign preorder SKUs only', () => {
    const [frame, strap] = applyCampaign(catalog('preorder'), CONFIG, {'OPENFRAME-5': 12}).products[0].variants;
    assert.equal(frame.campaign?.targetOrdered, 12);
    assert.equal(frame.ship_promise, PENDING);
    assert.equal(frame.availability, 'preorder');
    assert.equal(strap.campaign, undefined);
    assert.equal(strap.ship_promise, 'ships in about 10 weeks');
  });

  it('closes campaign SKUs when the paid counts could not be verified', () => {
    const [frame, strap] = applyCampaign(catalog('preorder'), CONFIG, null).products[0].variants;
    assert.equal(frame.availability, 'sold_out');
    assert.equal(frame.ship_promise, null);
    assert.equal(strap.availability, 'preorder');
    assert.equal(applyCampaign(catalog('preorder'), CONFIG, null).campaign_counts, 'unavailable');
  });

  it('closes a SKU whose early units are gone while Shopify still charges the early price', () => {
    const [frame] = applyCampaign(catalog('preorder'), CONFIG, {'OPENFRAME-5': 250}).products[0].variants;
    assert.equal(frame.availability, 'sold_out');
    assert.equal(frame.campaign, null);
  });

  it('reopens that SKU once the Shopify price is raised to the full price', () => {
    const raised = catalog('preorder');
    raised.products[0].variants[0] = {...raised.products[0].variants[0], price: 99, compare_price: null};
    const [frame] = applyCampaign(raised, CONFIG, {'OPENFRAME-5': 250}).products[0].variants;
    assert.equal(frame.availability, 'preorder');
    assert.equal(frame.campaign?.earlyPrice, false);
    assert.equal(frame.campaign?.batch, 2);
  });

  it('leaves a SKU the policy keeps closed untouched', () => {
    const [frame] = applyCampaign(catalog('sold_out'), CONFIG, {'OPENFRAME-5': 12}).products[0].variants;
    assert.equal(frame.availability, 'sold_out');
    assert.equal(frame.campaign, undefined);
  });

  it('asks for counts only when a campaign SKU is on preorder', () => {
    assert.equal(needsCampaignCounts(catalog('preorder'), CONFIG), true);
    assert.equal(needsCampaignCounts(catalog('sold_out'), CONFIG), false);
  });
});
