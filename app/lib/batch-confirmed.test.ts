import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import type {Catalog, CatalogVariant} from './catalog.ts';
import {
  STOCK_ORDER_DAY,
  afterEndsOn,
  applyCampaign,
  parseCampaignConfig,
  shipGroupKey,
  shipLabel,
  shipOrderDay,
  tiersFor,
  type CampaignConfig,
} from './preorder-campaign.ts';
import {stepBarView} from './preorder-meter.ts';
import {lineAttributes} from './shopify-cart-action.ts';
import {targetPrice} from './shopify-price-tier.ts';
import {batchPromiseOf} from './accounts/customer-shopify.ts';
import {orderStatus} from './accounts/order-display.ts';

// The confirmed batch model (founder 2026-11-11, terms 2.9), on the committed
// content/preorders.json: batch 1 is stock in Belgium for the EU, the March
// 2027 batch is produced whatever its count.
//   node --experimental-strip-types --test app/lib/batch-confirmed.test.ts

const REAL = parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')));
const BEFORE = new Date('2026-11-20T12:00:00Z');
// 16 December 2026, 00:30 in Brussels: the day after `endsOn`.
const AFTER = new Date('2026-12-15T23:30:00Z');

function variant(sku: string, price: number, retail: number): CatalogVariant {
  return {
    sku, title: sku, model: null, options: {}, price, compare_price: retail, currency: 'EUR', availability: 'preorder',
    ship_promise: null, image: null, url: `/products/${sku}`, cart_add_url: `/api/shopify/cart?sku=${sku}&qty=1`,
    merchandise_id: `gid://shopify/ProductVariant/${sku}`,
  };
}
function catalog(variants: CatalogVariant[]): Catalog {
  return {
    schema: 1, generated_at: '2026-11-11T00:00:00Z', max_age: 300, currency: 'EUR', prices_include_vat: true,
    shop_url: 'https://store.myshopify.com', cart_url: 'https://store.myshopify.com', add_url: '/api/shopify/cart',
    products: [{handle: 'p', title: 'P', family: null, description: null, url: '/products/p', images: [], rating: null, variants}],
  };
}
const RAW = catalog([variant('OPENFC-LITE-2020', 47.2, 59), variant('OPENRX-LITE', 15.2, 19)]);
const read = (config: CampaignConfig, now: Date, region: 'EU' | 'US' = 'EU', units: Record<string, number> = {}) => {
  const [fc, rx] = applyCampaign(RAW, config, units, now, region).products[0].variants;
  return {fc, rx};
};

describe('the March 2027 batch is confirmed', () => {
  it('sells a unit of it on an unconditional promise, with nothing left to reach', () => {
    const {rx} = read(REAL, BEFORE, 'EU', {'OPENRX-LITE': 3});
    assert.equal(rx.availability, 'preorder');
    assert.equal(rx.ship_promise, 'ships by 31 March 2027');
    assert.equal(rx.campaign?.confirmed, true);
    assert.equal(rx.campaign?.targetReached, true);
    assert.equal(rx.campaign?.shipByDay, '2027-03-31');
    assert.equal(shipLabel(rx.campaign!, 'short'), 'Ships by 31 Mar 2027');
    assert.equal(shipLabel(rx.campaign!, 'long'), 'Ships by 31 March 2027.');
    // The meter is a plain statement: confirmed, no count toward a target.
    const bar = stepBarView(rx.campaign!, tiersFor(REAL, 'OPENRX-LITE', BEFORE).map((t) => t.upTo));
    assert.equal(bar.confirmed, true);
    // The early-bird price still steps by paid units.
    assert.equal(rx.campaign?.earlyPrice, true);
    assert.equal(rx.campaign?.price, 15.2);
  });

  it('puts every line of the batch in one ship group, apart from stock', () => {
    const {fc, rx} = read(REAL, BEFORE, 'US');
    assert.equal(shipGroupKey(fc.sku, fc.ship_promise, fc.campaign), 'batch:2027-03-31');
    assert.equal(shipGroupKey(rx.sku, rx.ship_promise, rx.campaign), 'batch:2027-03-31');
    const eu = read(REAL, BEFORE, 'EU');
    assert.equal(shipGroupKey(eu.fc.sku, eu.fc.ship_promise, eu.fc.campaign), `date:${eu.fc.ship_promise}`);
  });

  it('writes the unconditional promise and the delivery date on the checkout line', () => {
    const {rx} = read(REAL, BEFORE);
    assert.deepEqual(lineAttributes(rx, 'EU'), [
      {key: 'Preorder', value: 'ships by 31 March 2027'},
      {key: 'Delivery by', value: '15 April 2027'},
      {key: '_batch', value: 'OPENRX-LITE:1'},
    ]);
  });

  it('a campaign that still runs on targets keeps its condition', () => {
    const target = parseCampaignConfig({
      ...(JSON.parse(JSON.stringify(REAL)) as CampaignConfig),
      confirmed: false,
      pendingShips: 'ships by 31 March 2027 if the target is reached by 15 December 2026, otherwise you choose a refund or to wait',
    });
    const {rx} = read(target, BEFORE, 'EU', {'OPENRX-LITE': 3});
    assert.equal(rx.campaign?.confirmed, undefined);
    assert.equal(rx.campaign?.targetReached, false);
    assert.equal(shipLabel(rx.campaign!, 'short'), 'Ships by 31 Mar 2027 if the target is reached');
    assert.equal(shipGroupKey(rx.sku, rx.ship_promise, rx.campaign), 'target:OPENRX-LITE:1');
    // Its unreached target closes at the deadline, as before.
    assert.equal(read(target, AFTER, 'EU', {'OPENRX-LITE': 3}).rx.availability, 'sold_out');
  });
});

describe('after 15 December 2026: one value, three modes', () => {
  const mode = (afterEndsOn: 'closed' | 'retail' | 'earlyBird') => parseCampaignConfig({...(JSON.parse(JSON.stringify(REAL)) as CampaignConfig), afterEndsOn});

  it('is retail until the founder says otherwise', () => {
    assert.equal(REAL.afterEndsOn, 'retail');
    assert.equal(afterEndsOn(REAL, BEFORE), null);
    assert.equal(afterEndsOn(REAL, new Date('2026-12-15T22:59:59Z')), null, '23:59 in Brussels on 15 December is still early bird');
    assert.equal(afterEndsOn(REAL, AFTER), 'retail');
  });

  it('retail: stays open at the retail price from 16 December, no price step', () => {
    assert.deepEqual(tiersFor(REAL, 'OPENRX-LITE', BEFORE).map((t) => t.off), [0.2, 0.1]);
    assert.deepEqual(tiersFor(REAL, 'OPENRX-LITE', AFTER), []);
    // Shopify still charges the early-bird price: closed until the price writer has set retail.
    assert.equal(read(REAL, AFTER).rx.availability, 'sold_out');
    const priced = catalog([variant('OPENFC-LITE-2020', 59, 59), variant('OPENRX-LITE', 19, 19)]);
    const rx = applyCampaign(priced, REAL, {}, AFTER, 'EU').products[0].variants[1];
    assert.equal(rx.availability, 'preorder');
    assert.equal(rx.ship_promise, 'ships by 31 March 2027');
    assert.equal(rx.campaign?.earlyPrice, false);
    assert.equal(rx.campaign?.price, 19);
  });

  it('retail: the price writer sets retail from 16 December', (t) => {
    t.mock.timers.enable({apis: ['Date'], now: AFTER.getTime()});
    assert.deepEqual(targetPrice(REAL, 3, 19, 'OPENRX-LITE'), {price: 19, compareAt: null});
    t.mock.timers.setTime(BEFORE.getTime());
    assert.deepEqual(targetPrice(REAL, 3, 19, 'OPENRX-LITE'), {price: 15.2, compareAt: 19});
  });

  it('earlyBird: stays open with the price steps running', () => {
    const config = mode('earlyBird');
    assert.equal(afterEndsOn(config, AFTER), 'earlyBird');
    const {rx} = read(config, AFTER);
    assert.equal(rx.availability, 'preorder');
    assert.equal(rx.campaign?.earlyPrice, true);
    assert.equal(rx.campaign?.price, 15.2);
  });

  it('closed: the March batch stops selling, stock in Belgium keeps selling', () => {
    const config = mode('closed');
    const {fc, rx} = read(config, AFTER);
    assert.equal(rx.availability, 'sold_out');
    assert.equal(fc.availability, 'preorder');
    assert.equal(fc.campaign?.paidStock, true);
    assert.equal(read(config, BEFORE).rx.availability, 'preorder');
  });

  it('refuses any other mode', () => {
    assert.throws(() => parseCampaignConfig({...(JSON.parse(JSON.stringify(REAL)) as CampaignConfig), afterEndsOn: 'open'}), /afterEndsOn must be closed, retail, earlyBird/);
  });
});

describe('batch 1 is stock in Belgium for the EU', () => {
  it('sells an EU unit from stock: no ship month, no delivery date, and it sorts before every dated line', () => {
    const {fc, rx} = read(REAL, BEFORE);
    assert.equal(fc.ship_promise, 'in stock in Belgium, ships to EU addresses in a few working days');
    assert.equal(fc.campaign?.inStock, true);
    assert.equal(fc.campaign?.deliveryByDay, null);
    assert.equal(shipLabel(fc.campaign!, 'short'), 'In stock, ships in a few working days');
    assert.equal(shipOrderDay(fc.campaign), STOCK_ORDER_DAY);
    assert.ok(shipOrderDay(fc.campaign)! < shipOrderDay(rx.campaign)!);
  });

  it('never writes a Preorder property or a delivery date for it, known country or not', () => {
    const {fc} = read(REAL, BEFORE);
    for (const known of [true, false]) {
      assert.deepEqual(lineAttributes(fc, 'EU', known), [
        {key: 'Shipping', value: 'In stock in Belgium, ships in a few working days.'},
        {key: '_ship_promise', value: 'in stock in Belgium, ships to EU addresses in a few working days'},
        {key: '_batch', value: 'OPENFC-LITE-2020:1'},
      ]);
    }
  });

  it('gives a US buyer the March batch, never the stock', () => {
    const {fc} = read(REAL, BEFORE, 'US');
    assert.equal(fc.campaign?.paidStock, false);
    assert.equal(fc.ship_promise, 'ships by 31 March 2027');
  });

  it('reads an order from stock as processing on the account page, not as a pre-order', () => {
    const promise = batchPromiseOf(REAL.skus['OPENFC-LITE-2020'].batches[0], REAL);
    assert.deepEqual(promise, {kind: 'date', day: STOCK_ORDER_DAY, text: 'ships in a few working days', stock: true});
    const status = orderStatus({cancelled: false, financialStatus: 'PAID', fulfillmentStatus: 'UNFULFILLED', isPreorder: true, promise} as Parameters<typeof orderStatus>[0]);
    assert.deepEqual(status, {tone: 'processing', label: 'Processing', note: 'Ships in a few working days.'});
    const march = batchPromiseOf(REAL.skus['OPENFC-LITE-2020'].batches[1], REAL);
    assert.deepEqual(march, {kind: 'target', day: '2027-03-31', text: 'ships by 31 Mar 2027'});
  });
});
