import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it, test} from 'node:test';
import type {Catalog} from './catalog.ts';
import {
  applyCampaign,
  campaignDate,
  campaignEndsAt,
  campaignState,
  fundingClosed,
  latestShipDate,
  latestShipDay,
  needsCampaignCounts,
  parseCampaignConfig,
  promiseDeliveredBy,
  priceLadder,
  cartShipNote,
  shipGroupKey,
  shipsWithState,
  shipLabel,
  shipLabelFromPromise,
  shortCampaignDate,
  tiersFor,
  type CampaignBatch,
} from './preorder-campaign.ts';

const PENDING =
  'ships about 10 weeks after its target is reached: by 11 March 2027 if the target is reached by 31 December 2026, otherwise you choose a refund or to wait';
const STACK: CampaignBatch[] = [
  {units: 250, paid: true, ships: 'ships late October 2026'},
  {units: 250},
];
const FRAME: CampaignBatch[] = [{units: 250}, {units: 1000}];
const TIERS = [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}];

describe('campaignState', () => {
  it('lists sold-out batches, the current one and the next', () => {
    const s = campaignState(STACK, 260, PENDING, TIERS);
    assert.deepEqual(
      s.batches.map(({batch, status, shipPromise}) => [batch, status, shipPromise]),
      [[1, 'sold_out', 'ships late October 2026'], [2, 'current', PENDING]],
    );
    assert.deepEqual(campaignState(FRAME, 0, PENDING, TIERS).batches.map((b) => b.status), ['current', 'next']);
  });

  it('sells paid stock with its own ship date and no early price', () => {
    const s = campaignState(STACK, 107, PENDING, TIERS);
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
    const s = campaignState(STACK, 250, PENDING, TIERS);
    assert.equal(s.batch, 2);
    assert.equal(s.paidStock, false);
    assert.equal(s.batchOrdered, 0);
    assert.equal(s.shipPromise, PENDING);
    assert.equal(s.earlyPrice, false);
    assert.equal(s.targetReached, false);
  });

  it('steps the price by paid units, whatever the batches', () => {
    const first = campaignState(FRAME, 40, PENDING, TIERS, 50);
    assert.equal(first.earlyPrice, true);
    assert.equal(first.tierUpTo, 100);
    assert.equal(first.tierLeft, 60);
    assert.equal(first.tierOff, 0.2);
    assert.equal(first.price, 40);
    assert.equal(first.nextPrice, 45);

    const second = campaignState(FRAME, 100, PENDING, TIERS, 50);
    assert.equal(second.tierUpTo, 250);
    assert.equal(second.tierLeft, 150);
    assert.equal(second.price, 45);
    assert.equal(second.nextPrice, 50);

    const full = campaignState(STACK, 260, PENDING, TIERS, 50);
    assert.equal(full.earlyPrice, false);
    assert.equal(full.tierUpTo, null);
    assert.equal(full.tierLeft, 0);
    assert.equal(full.price, 50);
    assert.equal(full.nextPrice, null);

    assert.equal(campaignState(FRAME, 0, PENDING, []).earlyPrice, false);
    assert.equal(campaignState(FRAME, 0, PENDING, TIERS).price, null, 'no retail, no price');
  });

  it('rounds a step to the cent', () => {
    assert.equal(campaignState(FRAME, 0, PENDING, TIERS, 29).price, 23.2);
    assert.equal(campaignState(FRAME, 150, PENDING, TIERS, 29).price, 26.1);
    assert.equal(campaignState(FRAME, 0, PENDING, [{upTo: 10, off: 0.15}], 19.99).price, 16.99);
  });

  it('counts toward the first target with the early price', () => {
    const s = campaignState(FRAME, 187, PENDING, TIERS);
    assert.equal(s.batch, 1);
    assert.equal(s.target, 250);
    assert.equal(s.targetOrdered, 187);
    assert.equal(s.targetReached, false);
    assert.equal(s.earlyPrice, true);
    assert.equal(s.shipPromise, PENDING);
  });

  it('reaches the target exactly at its unit count and opens the stretch batch', () => {
    const s = campaignState(FRAME, 250, PENDING, TIERS);
    assert.equal(s.targetReached, true);
    assert.equal(s.targetOrdered, 250);
    assert.equal(s.batch, 2);
    assert.equal(s.batchOrdered, 0);
    assert.equal(s.batchUnits, 1000);
    assert.equal(s.earlyPrice, false);
  });

  it('uses a batch ship promise once its supplier order is placed', () => {
    const placed: CampaignBatch[] = [{units: 250, ships: 'ships mid-December 2026'}, {units: 1000}];
    assert.equal(campaignState(placed, 10, PENDING, TIERS).shipPromise, 'ships mid-December 2026');
    assert.equal(campaignState(placed, 300, PENDING, TIERS).shipPromise, PENDING);
  });

  it('repeats the last batch size past the configured batches', () => {
    const s = campaignState(FRAME, 1250 + 1000 + 3, PENDING, TIERS);
    assert.equal(s.batch, 4);
    assert.equal(s.batchUnits, 1000);
    assert.equal(s.batchOrdered, 3);
  });

  it('treats a negative or non-finite count as zero', () => {
    assert.equal(campaignState(FRAME, -5, PENDING, TIERS).ordered, 0);
    assert.equal(campaignState(FRAME, Number.NaN, PENDING, TIERS).ordered, 0);
  });

  it('has no target when every batch is paid stock', () => {
    const s = campaignState([{units: 10, paid: true, ships: 'ships now'}], 3, PENDING, TIERS);
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

  it('keeps the committed pending ship promise in step with the deadline and the latest ship date', () => {
    const config = parseCampaignConfig(
      JSON.parse(
        fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'),
      ),
    );
    // Terms 7bis.2: a target reached by the deadline ships by that date.
    assert.ok(config.pendingShips.includes(campaignDate(config.endsOn)), 'names the deadline');
    assert.ok(config.pendingShips.includes(latestShipDate(config)), 'names the latest ship date');
    assert.ok(
      config.pendingShips.includes(`${config.shipWeeksAfterTarget ?? 10} weeks`),
      'names the weeks after the target',
    );
    assert.equal(config.pendingShips, PENDING);
    assert.ok(!config.pendingShips.includes('\u2014'), 'no em dash');
  });

  it('rejects a ship lead time that is not whole weeks', () => {
    assert.throws(
      () =>
        parseCampaignConfig({
          countFrom: '2026-09-21', endsOn: '2026-12-31', priceTiers: TIERS,
          pendingShips: PENDING, shipWeeksAfterTarget: 2.5,
          skus: {X: {batches: [{units: 10}]}},
        }),
      /shipWeeksAfterTarget/,
    );
  });

  it('rejects a paid batch without a ship promise', () => {
    assert.throws(
      () =>
        parseCampaignConfig({
          countFrom: '2026-09-21', endsOn: '2026-12-31', priceTiers: TIERS,
          pendingShips: PENDING,
          skus: {A: {batches: [{units: 1, paid: true}]}},
        }),
      /paid batch needs a ship promise/,
    );
  });

  it('rejects price tiers that are not whole and increasing', () => {
    for (const priceTiers of [undefined, [{upTo: 0, off: 0.2}], [{upTo: 100, off: 0.2}, {upTo: 100, off: 0.1}]]) {
      assert.throws(
        () =>
          parseCampaignConfig({
            countFrom: '2026-09-21', endsOn: '2026-12-31', priceTiers,
            pendingShips: PENDING,
            skus: {A: {batches: [{units: 1}]}},
          }),
        /priceTiers/,
      );
    }
  });

  it('rejects an off share outside 0 to 1', () => {
    for (const off of [0, 1, 1.5, '20%']) {
      assert.throws(
        () =>
          parseCampaignConfig({
            countFrom: '2026-09-21', endsOn: '2026-12-31', priceTiers: [{upTo: 100, off}],
            pendingShips: PENDING,
            skus: {A: {batches: [{units: 1}]}},
          }),
        /off share/,
      );
    }
  });

  it('rejects a batch without positive units', () => {
    assert.throws(
      () =>
        parseCampaignConfig({
          countFrom: '2026-09-21', endsOn: '2026-12-31', priceTiers: TIERS,
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
            price: 79.2,
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

/** A moment the funding targets are open, so these tests do not change
 *  meaning after the real deadline. */
const OPEN = new Date('2026-10-01T12:00:00Z');
const CONFIG = {countFrom: '2026-09-21', endsOn: '2026-12-31', priceTiers: TIERS, pendingShips: PENDING, skus: {'OPENFRAME-5': {batches: FRAME}}};

describe('latest ship date', () => {
  it('is the deadline plus the weeks after the target', () => {
    assert.equal(latestShipDay({endsOn: '2026-12-31', shipWeeksAfterTarget: 10}), '2027-03-11');
    assert.equal(latestShipDate({endsOn: '2026-12-31', shipWeeksAfterTarget: 10}), '11 March 2027');
    assert.equal(latestShipDate({endsOn: '2026-12-31'}), '11 March 2027', '10 weeks by default');
    assert.equal(campaignDate('2026-12-31'), '31 December 2026');
  });
});

describe('applyCampaign', () => {
  it('dates a funding-target unit with the deadline and the latest ship date', () => {
    const [frame] = applyCampaign(catalog('preorder'), CONFIG, {'OPENFRAME-5': 12}, OPEN).products[0].variants;
    assert.equal(frame.campaign?.deadline, '31 December 2026');
    assert.equal(frame.campaign?.latestShip, '11 March 2027');
    assert.match(frame.ship_promise ?? '', /by 11 March 2027 if the target is reached by 31 December 2026/);
  });

  it('sets the campaign state and ship promise on campaign preorder SKUs only', () => {
    const [frame, strap] = applyCampaign(catalog('preorder'), CONFIG, {'OPENFRAME-5': 12}, OPEN).products[0].variants;
    assert.equal(frame.campaign?.targetOrdered, 12);
    assert.equal(frame.ship_promise, PENDING);
    assert.equal(frame.availability, 'preorder');
    assert.equal(strap.campaign, undefined);
    assert.equal(strap.ship_promise, 'ships in about 10 weeks');
  });

  it('closes campaign SKUs when the paid counts could not be verified', () => {
    const [frame, strap] = applyCampaign(catalog('preorder'), CONFIG, null, OPEN).products[0].variants;
    assert.equal(frame.availability, 'sold_out');
    assert.equal(frame.ship_promise, null);
    assert.equal(strap.availability, 'preorder');
    assert.equal(applyCampaign(catalog('preorder'), CONFIG, null, OPEN).campaign_counts, 'unavailable');
  });

  it('closes a SKU Shopify still prices under its step', () => {
    // 99 retail, 120 paid units: the step is 10% off (89.10), but Shopify
    // still charges the 20% price of 79.
    const [frame] = applyCampaign(catalog('preorder'), CONFIG, {'OPENFRAME-5': 120}, OPEN).products[0].variants;
    assert.equal(frame.availability, 'sold_out');
    assert.equal(frame.campaign, null);
  });

  it('keeps selling once the step is written', () => {
    const stepped = catalog('preorder');
    stepped.products[0].variants[0] = {...stepped.products[0].variants[0], price: 89.1};
    const [frame] = applyCampaign(stepped, CONFIG, {'OPENFRAME-5': 120}, OPEN).products[0].variants;
    assert.equal(frame.availability, 'preorder');
    assert.equal(frame.campaign?.price, 89.1);
    assert.equal(frame.campaign?.nextPrice, 99);
  });

  it('sells at retail past the last step', () => {
    const full = catalog('preorder');
    full.products[0].variants[0] = {...full.products[0].variants[0], price: 99, compare_price: null};
    const [frame] = applyCampaign(full, CONFIG, {'OPENFRAME-5': 250}, OPEN).products[0].variants;
    assert.equal(frame.availability, 'preorder');
    assert.equal(frame.campaign?.earlyPrice, false);
    assert.equal(frame.campaign?.nextPrice, null);
  });

  it('leaves a SKU the policy keeps closed untouched', () => {
    const [frame] = applyCampaign(catalog('sold_out'), CONFIG, {'OPENFRAME-5': 12}, OPEN).products[0].variants;
    assert.equal(frame.availability, 'sold_out');
    assert.equal(frame.campaign, undefined);
  });

  it('asks for counts only when a campaign SKU is on preorder', () => {
    assert.equal(needsCampaignCounts(catalog('preorder'), CONFIG), true);
    assert.equal(needsCampaignCounts(catalog('sold_out'), CONFIG), false);
  });
});

describe('priceLadder', () => {
  it('lists every step by unit number, ending at retail', () => {
    assert.deepEqual(priceLadder(39, TIERS), [
      {from: 1, to: 100, price: 31.2},
      {from: 101, to: 250, price: 35.1},
      {from: 251, to: null, price: 39},
    ]);
  });

  it('is retail alone without tiers, and rounds to the cent', () => {
    assert.deepEqual(priceLadder(19.999, []), [{from: 1, to: null, price: 20}]);
    assert.deepEqual(priceLadder(29, [{upTo: 50, off: 0.15}]), [
      {from: 1, to: 50, price: 24.65},
      {from: 51, to: null, price: 29},
    ]);
  });

  it('matches the tiers in content/preorders.json', () => {
    const config = parseCampaignConfig(JSON.parse(fs.readFileSync('content/preorders.json', 'utf8')));
    const ladder = priceLadder(59, config.priceTiers);
    assert.deepEqual(ladder.map((s) => [s.from, s.to]), [[1, 100], [101, 250], [251, null]]);
    assert.deepEqual(ladder.map((s) => s.price), [47.2, 53.1, 59]);
  });
});

describe('paid batch and ship groups', () => {
  it('counts the units left in the paid batch, and none once it is sold', () => {
    assert.equal(campaignState(STACK, 240, PENDING, TIERS).paidLeft, 10);
    assert.equal(campaignState(STACK, 0, PENDING, TIERS).paidLeft, 250);
    assert.equal(campaignState(STACK, 250, PENDING, TIERS).paidLeft, null);
    assert.equal(campaignState(FRAME, 10, PENDING, TIERS).paidLeft, null);
  });

  it('ships paid stock on its date and a funding batch on its target', () => {
    assert.equal(campaignState(STACK, 10, PENDING, TIERS).shipsOnTarget, false);
    assert.equal(campaignState(STACK, 250, PENDING, TIERS).shipsOnTarget, true);
    assert.equal(campaignState([{units: 250, ships: 'ships March 2027'}], 3, PENDING, TIERS).shipsOnTarget, false);
  });

  it('groups fixed dates by date and funding batches by SKU and batch', () => {
    const fc = campaignState(STACK, 10, PENDING, TIERS);
    const rx = campaignState(FRAME, 10, PENDING, TIERS);
    const motor = campaignState([{units: 1000}, {units: 4000}], 10, PENDING, TIERS);
    // FC and ESC from their paid batches ship together.
    assert.equal(
      shipGroupKey('OPENFC-LITE-2020', fc.shipPromise, fc),
      shipGroupKey('OPENESC-2020', fc.shipPromise, fc),
    );
    // Same promise text, different targets: not the same shipment.
    assert.equal(rx.shipPromise, motor.shipPromise);
    assert.notEqual(
      shipGroupKey('OPENRX-LITE', rx.shipPromise, rx),
      shipGroupKey('OPENMOTOR-2207', motor.shipPromise, motor),
    );
    assert.equal(shipGroupKey('OPENRX-LITE', rx.shipPromise, rx), 'target:OPENRX-LITE:1');
    // Without campaign data (in stock, or counts unavailable): the promise text.
    assert.equal(shipGroupKey('ACC-1', null, null), 'date:');
    assert.equal(shipGroupKey('X', 'ships late October 2026', undefined), 'date:ships late October 2026');
  });
});

describe('funding deadline (endsOn)', () => {
  // 31 December 2026 is CET (UTC+1): 23:59 Brussels is 22:59 UTC.
  const LAST_MINUTE = new Date('2026-12-31T22:59:00Z');
  const LAST_MS = new Date('2026-12-31T22:59:59.999Z');
  const AFTER = new Date('2026-12-31T23:00:00Z');
  const STACK_CONFIG = {...CONFIG, skus: {'OPENFRAME-5': {batches: STACK}}};

  it('ends at midnight after endsOn in Brussels, summer or winter', () => {
    assert.equal(campaignEndsAt('2026-12-31').toISOString(), '2026-12-31T23:00:00.000Z');
    // CEST (UTC+2) in July.
    assert.equal(campaignEndsAt('2026-07-15').toISOString(), '2026-07-15T22:00:00.000Z');
    // The night the clocks go back: midnight after 24 October is still CEST.
    assert.equal(campaignEndsAt('2026-10-24').toISOString(), '2026-10-24T22:00:00.000Z');
    // After 25 October the offset is CET again.
    assert.equal(campaignEndsAt('2026-10-25').toISOString(), '2026-10-25T23:00:00.000Z');
  });

  it('is open through 23:59 on 31 December in Brussels and closed from midnight', () => {
    assert.equal(fundingClosed(CONFIG, LAST_MINUTE), false);
    assert.equal(fundingClosed(CONFIG, LAST_MS), false);
    assert.equal(fundingClosed(CONFIG, AFTER), true);
    assert.equal(fundingClosed(CONFIG, new Date('2027-03-01T00:00:00Z')), true);
  });

  it('keeps a funding-target SKU on sale at 23:59 and closes it at midnight', () => {
    const [before] = applyCampaign(catalog('preorder'), CONFIG, {'OPENFRAME-5': 12}, LAST_MINUTE).products[0].variants;
    assert.equal(before.availability, 'preorder');
    assert.equal(before.ship_promise, PENDING);
    const [after, strap] = applyCampaign(catalog('preorder'), CONFIG, {'OPENFRAME-5': 12}, AFTER).products[0].variants;
    assert.equal(after.availability, 'sold_out');
    assert.equal(after.ship_promise, null);
    assert.equal(after.campaign, null);
    // A SKU without a campaign entry is not touched by the deadline.
    assert.equal(strap.availability, 'preorder');
  });

  it('keeps paid stock on sale after the deadline, and closes it once only a funding batch is left', () => {
    const early = catalog('preorder');
    // 12 paid units: 20% step, 79.20 on a 99 retail.
    early.products[0].variants[0] = {...early.products[0].variants[0], price: 79.2};
    const [paid] = applyCampaign(early, STACK_CONFIG, {'OPENFRAME-5': 12}, AFTER).products[0].variants;
    assert.equal(paid.availability, 'preorder');
    assert.equal(paid.campaign?.paidStock, true);
    assert.equal(paid.ship_promise, 'ships late October 2026');
    const retail = catalog('preorder');
    retail.products[0].variants[0] = {...retail.products[0].variants[0], price: 99};
    const [spent] = applyCampaign(retail, STACK_CONFIG, {'OPENFRAME-5': 250}, AFTER).products[0].variants;
    assert.equal(spent.availability, 'sold_out');
    const [open] = applyCampaign(retail, STACK_CONFIG, {'OPENFRAME-5': 250}, LAST_MINUTE).products[0].variants;
    assert.equal(open.availability, 'preorder');
  });

  it('keeps a batch whose supplier order is placed (its own ship date) on sale', () => {
    const placed = {...CONFIG, skus: {'OPENFRAME-5': {batches: [{units: 250, ships: 'ships March 2027'}, {units: 1000}]}}};
    const [frame] = applyCampaign(catalog('preorder'), placed, {'OPENFRAME-5': 12}, AFTER).products[0].variants;
    assert.equal(frame.availability, 'preorder');
    assert.equal(frame.ship_promise, 'ships March 2027');
  });

  it('reads the deadline from content/preorders.json as 31 December 2026', () => {
    const config = parseCampaignConfig(JSON.parse(fs.readFileSync('content/preorders.json', 'utf8')));
    assert.equal(campaignEndsAt(config.endsOn).toISOString(), '2026-12-31T23:00:00.000Z');
  });
});

describe('price steps inside one cart line', () => {
  it('prices every unit of the next order at the current step, even past its end', () => {
    // 95 paid: 5 units left at 20% off. A line of 10 is charged at the
    // Shopify price, which is this step: the buyer gets the cheaper price
    // on all 10 (founder decision, kept on purpose).
    const s = campaignState(FRAME, 95, PENDING, TIERS, 39);
    assert.equal(s.tierLeft, 5);
    assert.equal(s.price, 31.2);
    assert.equal(s.nextPrice, 35.1);
    // The step moves only once those units are paid.
    const after = campaignState(FRAME, 105, PENDING, TIERS, 39);
    assert.equal(after.price, 35.1);
    assert.equal(after.tierUpTo, 250);
  });

  it('steps at the exact unit boundaries: 100 is the last 20% unit, 250 the last 10% unit', () => {
    assert.equal(campaignState(FRAME, 99, PENDING, TIERS, 39).price, 31.2);
    assert.equal(campaignState(FRAME, 100, PENDING, TIERS, 39).price, 35.1);
    assert.equal(campaignState(FRAME, 249, PENDING, TIERS, 39).price, 35.1);
    assert.equal(campaignState(FRAME, 250, PENDING, TIERS, 39).price, 39);
    assert.equal(campaignState(FRAME, 250, PENDING, TIERS, 39).earlyPrice, false);
  });

  it('sells paid stock at the last unit and moves to the funding batch after it', () => {
    const last = campaignState(STACK, 249, PENDING, TIERS);
    assert.equal(last.paidStock, true);
    assert.equal(last.paidLeft, 1);
    const next = campaignState(STACK, 250, PENDING, TIERS);
    assert.equal(next.paidStock, false);
    assert.equal(next.target, 250);
    assert.equal(next.targetOrdered, 0);
    assert.equal(next.shipPromise, PENDING);
  });
});

describe('shipLabel', () => {
  const LONG =
    'Ships about 10 weeks after its target is reached: by 11 March 2027 if the target is reached by 31 December 2026, otherwise you choose a refund or to wait.';

  it('gives a funding-target SKU a short label and the full sentence as the long form', () => {
    const state = {...campaignState(FRAME, 12, PENDING, TIERS), latestShip: '11 March 2027'};
    assert.equal(shipLabel(state, 'short'), 'ETA 11 Mar 2027 if funded');
    assert.equal(shipLabel(state, 'long'), LONG);
    const bare = campaignState(FRAME, 12, PENDING, TIERS);
    assert.equal(shipLabel(bare, 'short'), 'ETA 11 Mar 2027 if funded');
  });

  it('gives paid stock its batch date in both forms', () => {
    const state = campaignState(STACK, 10, PENDING, TIERS);
    assert.equal(shipLabel(state, 'short'), 'Ships Oct 2026');
    assert.equal(shipLabel(state, 'long'), 'Ships late October 2026.');
    const past = campaignState(STACK, 250, PENDING, TIERS);
    assert.equal(shipLabel(past, 'short'), 'ETA 11 Mar 2027 if funded');
  });

  it('reads the same labels from the promise text alone', () => {
    assert.equal(shipLabelFromPromise(PENDING, 'short'), 'ETA 11 Mar 2027 if funded');
    assert.equal(shipLabelFromPromise(PENDING, 'long'), LONG);
    assert.equal(shipLabelFromPromise('ships late October 2026', 'short'), 'Ships Oct 2026');
    assert.equal(shipLabelFromPromise('ships late October 2026', 'long'), 'Ships late October 2026.');
    assert.equal(shipLabelFromPromise(null, 'short'), null);
    assert.equal(shipLabelFromPromise('  ', 'long'), null);
  });

  it('matches the configured promise in content/preorders.json', () => {
    const config = parseCampaignConfig(
      JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')),
    );
    const short = `ETA ${shortCampaignDate(latestShipDate(config))} if funded`;
    assert.equal(shipLabelFromPromise(config.pendingShips, 'short'), short);
  });

  it('writes a short date without the September abbreviation quirk', () => {
    assert.equal(shortCampaignDate('11 March 2027'), '11 Mar 2027');
    assert.equal(shortCampaignDate('1 September 2027'), '1 Sep 2027');
    assert.equal(shortCampaignDate('late October 2026'), null);
  });

  it('puts the long funding sentence in a cart note once, only when a line waits for a target', () => {
    assert.equal(cartShipNote(['ships late October 2026', PENDING, PENDING]), LONG);
    assert.equal(cartShipNote(['ships late October 2026', null]), null);
    assert.equal(cartShipNote([]), null);
  });
});

describe('SKUs that ship with a campaign SKU', () => {
  const WITH = {
    ...CONFIG,
    skus: {'OPENFRAME-5': {batches: FRAME}, 'OPENFC-LITE-2020': {batches: STACK}},
    shipsWith: {
      'ACC-STRAP-20X220': {sku: 'OPENFC-LITE-2020', batch: 1},
      'ACC-FRM-ARM-5': {sku: 'OPENFRAME-5'},
    },
  };
  const spare = (catalogIn: Catalog) => {
    catalogIn.products[0].variants.push({
      ...catalogIn.products[0].variants[1],
      sku: 'ACC-FRM-ARM-5',
      price: 7.5,
      ship_promise: null,
    });
    return catalogIn;
  };

  it('parses the real config: every accessory rides a campaign SKU', () => {
    const real = parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')));
    const rules = Object.entries(real.shipsWith ?? {});
    assert.ok(rules.length > 0);
    for (const [sku, rule] of rules) {
      assert.ok(sku.startsWith('ACC-'), sku);
      assert.ok(real.skus[rule.sku], `${sku} rides ${rule.sku}`);
      assert.deepEqual(tiersFor(real, sku), [], `${sku} has a flat price`);
    }
    assert.equal(real.shipsWith?.['ACC-PROP-5-HQ-J37']?.batch, 1);
    assert.equal(real.shipsWith?.['ACC-FRM-ARM-3']?.sku, 'OPENFRAME-3');
  });

  it('rejects a lead that is not a campaign SKU or a pinned batch without a date', () => {
    assert.throws(() => parseCampaignConfig({...WITH, shipsWith: {X: {sku: 'NOPE'}}}), /unknown campaign SKU/);
    assert.throws(
      () => parseCampaignConfig({...WITH, shipsWith: {X: {sku: 'OPENFC-LITE-2020', batch: 2}}}),
      /no ship date/,
    );
    assert.throws(
      () => parseCampaignConfig({...WITH, shipsWith: {'OPENFRAME-5': {sku: 'OPENFC-LITE-2020'}}}),
      /cannot ship with another/,
    );
  });

  it('pins stock accessories to the dated batch at a flat price, whatever the lead sold', () => {
    const [, strap] = applyCampaign(catalog('preorder'), WITH, {'OPENFC-LITE-2020': 400}, OPEN).products[0].variants;
    assert.equal(strap.availability, 'preorder');
    assert.equal(strap.ship_promise, 'ships late October 2026');
    assert.equal(strap.campaign?.earlyPrice, false);
    assert.equal(strap.campaign?.paidStock, false);
    assert.equal(strap.campaign?.shipsOnTarget, false);
    assert.equal(strap.campaign?.price, 2);
    assert.equal(shipLabel(strap.campaign!, 'short'), 'Ships Oct 2026');
  });

  it('lets spares follow the frame target, grouped with the frame in a cart', () => {
    const [frame, , arm] = applyCampaign(spare(catalog('preorder')), WITH, {'OPENFRAME-5': 12}, OPEN).products[0].variants;
    assert.equal(arm.ship_promise, frame.ship_promise);
    assert.equal(arm.campaign?.latestShip, '11 March 2027');
    assert.equal(arm.campaign?.earlyPrice, false);
    assert.equal(arm.campaign?.price, 7.5);
    assert.equal(shipGroupKey('ACC-FRM-ARM-5', arm.ship_promise, arm.campaign), shipGroupKey('OPENFRAME-5', frame.ship_promise, frame.campaign));
  });

  it('closes spares after the deadline and keeps the pinned accessories selling', () => {
    const late = new Date('2027-01-05T12:00:00Z');
    const [, strap, arm] = applyCampaign(spare(catalog('preorder')), WITH, {'OPENFRAME-5': 12}, late).products[0].variants;
    assert.equal(arm.availability, 'sold_out');
    assert.equal(strap.availability, 'preorder');
  });

  it('asks for counts when only an accessory is on preorder', () => {
    const c = catalog('sold_out');
    c.products[0].variants[1] = {...c.products[0].variants[1], availability: 'preorder'};
    assert.equal(needsCampaignCounts(c, WITH), true);
  });
});

test('a reviewed final delivery promise follows the batch into the catalog and its accessories', () => {
  const config = parseCampaignConfig({
    countFrom: '2026-09-21', endsOn: '2026-12-31', pendingShips: 'ships once funded', priceTiers: [],
    skus: {A: {batches: [{units: 20, paid: true, ships: 'ships October 2026', deliveryBy: '2026-11-15'}]}},
    shipsWith: {B: {sku: 'A', batch: 1}},
  });
  const state = campaignState(config.skus.A.batches, 0, config.pendingShips, []);
  assert.equal(state.shipPromise, 'ships October 2026, delivered by 15 November 2026');
  const target = parseCampaignConfig({...config, shipsWith: {}, skus: {A: {batches: [{units: 20, deliveryBy: '2027-03-31'}]}}});
  // A funding target states its delivery date on the condition of its target.
  const pending = campaignState(target.skus.A.batches, 0, target.pendingShips, []).shipPromise;
  assert.equal(pending, 'ships once funded; if the target is reached in time, delivered by 31 March 2027');
  assert.equal(promiseDeliveredBy(state.shipPromise), '15 Nov 2026');
  assert.equal(promiseDeliveredBy(pending), '31 Mar 2027');
  assert.equal(promiseDeliveredBy('ships late October 2026'), null);
  assert.equal(state.batches[0].shipPromise, state.shipPromise);
  assert.equal(shipsWithState(config, config.shipsWith!.B, 0, 10).shipPromise, state.shipPromise);
  assert.throws(() => parseCampaignConfig({...config, skus: {A: {batches: [{units: 1, deliveryBy: '2027-02-30'}]}}}), /calendar date/);
});
