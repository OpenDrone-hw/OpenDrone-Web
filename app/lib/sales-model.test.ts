import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {bySku, toCards, type Catalog} from './catalog.ts';
import {availabilityRows, batchText, targetDates} from './availability.ts';
import {choiceCatalogData, CHOICE_POLICY} from './batch-choice-fixture.ts';
import {
  batchOnePromises,
  geoAvailabilityCopy,
  geoBarText,
  geoInStock,
  geoPreorderLine,
  geoShipText,
  shipByDate,
  stockRegionIn,
} from './geo-availability.ts';
import {applyCampaign, parseCampaignConfig, tiersFor, type Region} from './preorder-campaign.ts';
import {serverPreorderWords} from './preorder-words.ts';
import {isPurchasableStatus, PRODUCT_CONTENT, resolveStatus, type ProductContent} from './product-content.ts';
import {
  announcedProduct,
  defaultSalePolicy,
  fillSalesTokens,
  productNameOfSku,
  SALES,
  salesModel,
  salesTokens,
} from './sales-model.ts';
import {mapShopifyCatalog} from './shopify-storefront.ts';

/**
 * The point of the sales model: every everyday change to what the shop sells
 * is an edit of content/preorders.json or content/products/*.json, and every
 * page follows it with no code change. Each case below edits a copy of the
 * real file and reads the surfaces a buyer sees.
 */

type Raw = any;
const RAW: Raw = JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'));
const edited = (edit: (raw: Raw) => void): Raw => {
  const raw = structuredClone(RAW);
  edit(raw);
  return raw;
};
const NOW = new Date('2026-11-21T12:00:00Z');
const STOCK_TEXT: string = RAW.skus['OPENFC-LITE-2020'].batches[0].ships;
const MOTOR = 'OPENMOTOR-1604';
const OTHER = 'OPENFRAME-3';

/** The storefront catalog a buyer in `region` reads under `raw`. */
function catalogFor(raw: Raw, region: Region = 'EU', now = NOW, data = choiceCatalogData()): Catalog {
  const shopify = mapShopifyCatalog(data, 'open-drone-test.myshopify.com', JSON.stringify(CHOICE_POLICY), '1', 'default', true);
  return applyCampaign(shopify, parseCampaignConfig(structuredClone(raw)), {}, now, region);
}

/** What the buyer reads for one SKU, the surfaces that decide the lane. */
function surfaces(raw: Raw, sku: string, region: Region = 'EU') {
  const config = parseCampaignConfig(structuredClone(raw));
  const variant = bySku(catalogFor(raw, region), sku)!.variant;
  const geo = region === 'EU' ? 'eu' : region === 'US' ? 'intl' : 'intl';
  const batchOne = batchOnePromises(config);
  const campaign = variant.campaign!;
  return {
    promise: variant.ship_promise,
    // Product page and list card: "Add to cart" (stock) or "Pre-order".
    inStock: geoInStock(geo, {paidStock: campaign.paidStock, shipPromise: variant.ship_promise}, batchOne),
    // Cart: the "Early bird preorder prices." note shows only for a pre-order line.
    cartPreorderLine: geoPreorderLine(variant.ship_promise, geo, batchOne),
    // Product page availability block and the cart line's batch name.
    rows: availabilityRows(campaign, targetDates(campaign.deadline, campaign.latestShip), region, serverPreorderWords),
    batchName: batchText(campaign, serverPreorderWords),
  };
}

describe('sales model: today', () => {
  it('reads the words the copy files typed before', () => {
    assert.deepEqual(salesTokens(), {
      stock_from: 'Belgium',
      stock_scope: 'EU',
      stock_lines: 'FC and ESC',
      preorder_lines: 'RX, frames, motors',
      preorder_month: 'March 2027',
      preorder_ships_by: '31 March 2027',
    });
    assert.equal(SALES.shipsBy, RAW.shipsBy);
  });

  it('every {{token}} in content/copy is one the model fills', () => {
    const dir = new URL('../../content/copy/', import.meta.url);
    const known = salesTokens();
    for (const name of fs.readdirSync(dir)) {
      const text = fs.readFileSync(new URL(name, dir), 'utf8');
      for (const [, token] of text.matchAll(/\{\{(\w+)\}\}/g)) assert.ok(token in known, `${name}: {{${token}}}`);
    }
  });

  it('fills tokens and leaves anything else as written', () => {
    assert.equal(fillSalesTokens('From {{stock_from}}, {{stock_scope}} only. {count} left. {{typo}}'), 'From Belgium, EU only. {count} left. {{typo}}');
  });

  it('names a lead product from its SKU, not from a SKU prefix in code', () => {
    assert.equal(productNameOfSku('OPENFC-LITE-2020'), 'OpenFC Lite');
    assert.equal(productNameOfSku('OPENFRAME-5'), 'OpenFrame');
    assert.equal(productNameOfSku('ACC-STRAP-20X220'), null);
  });
});

describe('sales model: checked on load, with the file and field named', () => {
  it('a preorder SKU no product file lists', () => {
    assert.throws(
      () => salesModel(edited((raw) => { raw.skus['OPENVTX-1'] = {batches: [{units: 100}]}; })),
      /SKU OPENVTX-1 in content\/preorders\.json is in no product: add it to "skus" in content\/products\/<handle>\.json/,
    );
  });
  it('a missing stock place', () => {
    assert.throws(() => salesModel(edited((raw) => { delete raw.stockFrom; })), /content\/preorders\.json: stockFrom must name/);
  });
  it('a malformed campaign', () => {
    assert.throws(() => salesModel(edited((raw) => { raw.shipsBy = '2026-12-01'; })), /content\/preorders\.json: preorders: shipsBy must be a calendar date after endsOn/);
  });
  it('a SKU two product files claim', () => {
    const products = {...PRODUCT_CONTENT, copy: {...PRODUCT_CONTENT.openrx, skus: ['OPENRX-LITE']}};
    assert.throws(() => salesModel(RAW, products), /SKU OPENRX-LITE is listed by content\/products\/openrx\.json and content\/products\/copy\.json/);
  });
});

describe('sales model: a product moves from preorder to in stock', () => {
  // The data change: the motor's batch is now stock on hand, ahead of its
  // pre-order batch. No code change.
  const flipped = edited((raw) => {
    raw.skus[MOTOR].batches.unshift({units: 100, paid: true, inStock: true, ships: STOCK_TEXT});
  });

  it('before: a pre-order everywhere', () => {
    const now = surfaces(RAW, MOTOR);
    assert.equal(now.promise, 'ships by 31 March 2027');
    assert.equal(now.inStock, false);
    assert.equal(now.cartPreorderLine, true);
  });

  it('after: the in-stock lane on the product page, list card, cart and checkout line', () => {
    const now = surfaces(flipped, MOTOR);
    assert.equal(now.promise, STOCK_TEXT, 'checkout line property and order promise');
    assert.equal(now.inStock, true, 'Add to cart, not Pre-order');
    assert.equal(now.cartPreorderLine, false, 'no preorder note in the cart');
    assert.equal(now.rows[0].label, 'From Belgium');
    assert.equal(now.rows[0].detail, 'In stock, ships in a few working days');
    assert.equal(now.rows[0].state, 'current');
    assert.equal(now.batchName, 'From Belgium, EU addresses only');
    assert.equal(geoShipText('eu', 'en'), 'In stock in Belgium, ships in a few working days.');
  });

  it('after: outside the stock region the same motor stays a pre-order', () => {
    const now = surfaces(flipped, MOTOR, 'US');
    assert.equal(now.promise, 'ships by 31 March 2027');
    assert.equal(now.rows[0].state, 'other_region');
  });

  it('after: copy names the motors among the stock lines', () => {
    const model = salesModel(flipped);
    assert.deepEqual(model.stockProducts, ['openfc-lite', 'openesc', 'openmotor']);
    assert.equal(salesTokens(model).stock_lines, 'FC, ESC and motors');
    assert.equal(salesTokens(model).preorder_lines, 'RX, frames');
  });

  it('with no stock left in the model, the stock region reads the pre-order line', () => {
    const none = {...SALES, stockProducts: []};
    assert.equal(stockRegionIn('eu', none), false);
    assert.equal(geoBarText('eu', 'en', false, false, none), 'Pre-order, ships by 31 March 2027');
    assert.equal(geoShipText('eu', 'en', none), 'Pre-order, ships March 2027.');
  });
});

describe('sales model: a new product line is announced', () => {
  // The data change: content/products/openvtx.json with status
  // "development" and its SKU; the product exists in Shopify. No preorder.
  const vtx: ProductContent = {...PRODUCT_CONTENT.openrx, status: 'development', name: 'OpenVTX', lineName: 'VTX', skus: ['OPENVTX-1']};
  const products = {...PRODUCT_CONTENT, openvtx: vtx};
  const model = salesModel(RAW, products);

  it('the catalog reads it as not for sale instead of failing on an unknown SKU', () => {
    assert.deepEqual(defaultSalePolicy('OPENVTX-1', model), {saleMode: 'sold_out', shipPromise: null});
    const data = choiceCatalogData({extraSku: 'OPENVTX-1'});
    const catalog = mapShopifyCatalog(data, 'open-drone-test.myshopify.com', JSON.stringify(CHOICE_POLICY), '1', 'default', true, model);
    assert.equal(bySku(catalog, 'OPENVTX-1')!.variant.availability, 'sold_out');
    // A SKU no file names still fails closed.
    assert.throws(
      () => mapShopifyCatalog(choiceCatalogData({extraSku: 'MYSTERY-1'}), 'open-drone-test.myshopify.com', JSON.stringify(CHOICE_POLICY), '1', 'default', true, model),
      /missing catalog policy/,
    );
  });

  it('the product page and the list card show it with no cart button', () => {
    assert.equal(announcedProduct(vtx), true, 'list card: coming soon, no quick add');
    const status = resolveStatus('openvtx', false, {}, 'sold_out', vtx);
    assert.equal(status, 'development', 'product page: notify-me');
    assert.equal(isPurchasableStatus(status), false);
    // Today's products are not announced.
    for (const handle of ['openfc-lite', 'openesc', 'openrx', 'openframe', 'openmotor']) assert.equal(announcedProduct(PRODUCT_CONTENT[handle]), false, handle);
  });

  it('opening its preorder is an entry in content/preorders.json, not a secret edit', () => {
    const open = salesModel(edited((raw) => { raw.skus['OPENVTX-1'] = {batches: [{units: 100}]}; }), products);
    assert.deepEqual(defaultSalePolicy('OPENVTX-1', open), {saleMode: 'preorder', shipPromise: null});
    assert.equal(salesTokens(open, products).preorder_lines, 'RX, frames, motors, VTX');
  });
});

describe('sales model: an offer past its end date', () => {
  const ended = edited((raw) => { raw.endsOn = '2026-11-20'; });
  // Shopify once the price writer (shopify-price-tier.ts) has put every
  // stepped variant back at its retail (compare-at) price.
  const atRetail = () => {
    const data = choiceCatalogData();
    for (const p of data.products.nodes) for (const v of p.variants.nodes) if (v.compareAtPrice) v.price = v.compareAtPrice;
    return data;
  };
  const early = (raw: Raw, now: Date, data = choiceCatalogData()) =>
    toCards(catalogFor(raw, 'EU', now, data)).flatMap((p) => p.variants.nodes.filter((v) => v.earlyPrice != null).map((v) => v.sku));

  it('runs while the offer runs', () => {
    assert.ok(tiersFor(parseCampaignConfig(structuredClone(RAW)), 'OPENRX-LITE', NOW).length > 0);
    assert.ok(early(RAW, NOW).length > 0, 'early bird prices and notes show');
  });

  it('is gone the day after endsOn, with no code change', () => {
    assert.deepEqual(tiersFor(parseCampaignConfig(structuredClone(ended)), 'OPENRX-LITE', NOW), []);
    assert.deepEqual(early(ended, NOW, atRetail()), [], 'no early bird price, note or retail line anywhere');
    const motor = bySku(catalogFor(ended, 'EU', NOW, atRetail()), MOTOR)!.variant;
    assert.equal(motor.campaign!.earlyPrice, false);
    assert.equal(motor.availability, 'preorder', 'the preorder stays open at retail (afterEndsOn "retail")');
  });
});

describe('sales model: a preorder gets a new ship date', () => {
  const moved = edited((raw) => { raw.shipsBy = '2027-05-31'; });

  it('every place that names the date follows shipsBy', () => {
    const model = salesModel(moved);
    assert.equal(model.shipsBy, '2027-05-31');
    assert.equal(salesTokens(model).preorder_month, 'May 2027', 'copy');
    assert.equal(salesTokens(model).preorder_ships_by, '31 May 2027', 'copy');
    assert.equal(shipByDate('nl', 'long', model), '31 mei 2027');
    assert.equal(geoBarText('intl', 'en', false, false, model), 'Pre-order, ships by 31 May 2027', 'availability bar');
    assert.equal(geoAvailabilityCopy(model).fr.intl, 'Précommande, expédition en mai 2027.', 'product page line');
    const other = surfaces(moved, OTHER);
    assert.equal(other.promise, 'ships by 31 May 2027', 'cart line and checkout property');
    assert.equal(other.rows.at(-1)!.detail, 'Ships by 31 May 2027', 'availability block');
  });

  it('one product line on its own date: its lines name it, site-wide lines the latest', () => {
    const own = edited((raw) => { raw.skus[MOTOR].batches[0].ships = 'ships by 30 June 2027'; });
    assert.equal(surfaces(own, MOTOR).promise, 'ships by 30 June 2027');
    assert.equal(surfaces(own, OTHER).promise, 'ships by 31 March 2027');
    const model = salesModel(own);
    assert.equal(model.shipsBy, '2027-06-30');
    assert.equal(geoBarText('intl', 'en', false, false, model), 'Pre-order, ships by 30 June 2027');
  });
});
