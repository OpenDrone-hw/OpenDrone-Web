import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import type {Catalog, CatalogVariant} from './catalog.ts';
import {
  applyCampaign,
  batchFill,
  campaignState,
  parseCampaignConfig,
  promiseBatchMonth,
  shipsWithState,
  type CampaignBatch,
} from './preorder-campaign.ts';
import {notSoldDirect, shippingQuote} from './shipping-rates.ts';
import {handleShopifyCartAction, usSellable} from './shopify-cart-action.ts';
import {handleCartCountry} from './shopify-cart-country.ts';
import {mapShopifyCatalog, type CartLineInput, type ShopifyCart} from './shopify-storefront.ts';
import {US_SALES, fccConditionalSku, usSalesRate, usdBand, usdLadder, usdOf, withMarketPrices} from './us-sales.ts';
import {findUsList, nameWithUplift, planUplift, readUpliftPct} from '../../scripts/us-prices.mjs';
import {priceNote} from './visitor-country.ts';

const REAL = parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')));
const OPEN = new Date('2026-10-01T12:00:00Z');
const PENDING = 'ships by 31 March 2027 if the target is reached by 15 December 2026, otherwise you choose a refund or to wait';
const TIERS = [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}];
const EU_FIRST: CampaignBatch[] = [
  {units: 250, paid: true, ships: 'ships early November 2026', regions: ['EU']},
  {units: 250, deliveryBy: '2027-04-15'},
];

describe('US sales gate', () => {
  it('opens only with the gate "1" and a committed rate', () => {
    assert.equal(US_SALES.rate, 9.95);
    assert.equal(usSalesRate({PUBLIC_US_SALES: '1'}), 9.95);
    for (const gate of [undefined, '0', 'true', ' 1']) assert.equal(usSalesRate({PUBLIC_US_SALES: gate}), null);
  });

  it('stays closed with the gate on while the rate is null (fail closed)', () => {
    assert.equal(usSalesRate({PUBLIC_US_SALES: '1'}, {rate: null}), null);
    assert.equal(usSalesRate({PUBLIC_US_SALES: '1'}, {}), null);
    assert.equal(usSalesRate({PUBLIC_US_SALES: '1'}, {rate: -1}), null);
  });

  it('quotes the US as its own direct zone only while open', () => {
    assert.deepEqual(shippingQuote('US'), {country: 'US', kind: 'shops'});
    assert.deepEqual(shippingQuote('US', undefined, 9.95), {country: 'US', kind: 'direct', zone: 'us', rate: 9.95, currency: 'USD'});
    assert.equal(notSoldDirect('US'), 'shops');
    assert.equal(notSoldDirect('US', 9.95), null);
    // Other non-EU countries stay on the shops either way.
    assert.deepEqual(shippingQuote('CA', undefined, 9.95), {country: 'CA', kind: 'shops'});
    assert.equal(priceNote('US'), 'shops');
    assert.equal(priceNote('US', true), 'us');
    assert.equal(priceNote('BE', true), 'vat');
  });
});

describe('batch regions', () => {
  it('rejects unknown regions and a last funding batch that leaves a region out', () => {
    const base = {countFrom: '2026-09-25', endsOn: '2026-12-15', shipsBy: '2027-03-31', priceTiers: TIERS, pendingShips: PENDING};
    assert.throws(() => parseCampaignConfig({...base, skus: {A: {batches: [{units: 1, regions: ['UK']}]}}}), /regions/);
    assert.throws(() => parseCampaignConfig({...base, skus: {A: {batches: [{units: 1, regions: ['EU']}]}}}), /every region/);
    assert.ok(parseCampaignConfig({...base, skus: {A: {batches: EU_FIRST}}}));
  });

  it('marks the four paid batch-1 entries EU only in the committed file', () => {
    const euOnly = Object.entries(REAL.skus).filter(([, e]) => e.batches.some((b) => b.regions?.join() === 'EU'));
    assert.deepEqual(euOnly.map(([sku]) => sku).sort(), ['OPENESC-2020', 'OPENESC-3030', 'OPENFC-LITE-2020', 'OPENFC-LITE-3030']);
  });

  it('gives a US buyer batch 2 and its March promise while batch 1 still has units', () => {
    const us = campaignState(EU_FIRST, 40, PENDING, TIERS, 49, 'US');
    assert.equal(us.batch, 2);
    assert.equal(us.paidStock, false);
    assert.equal(us.paidLeft, null);
    assert.match(us.shipPromise, /31 March 2027/);
    assert.equal(promiseBatchMonth(us.shipPromise), 'March 2027');
    assert.deepEqual(us.batches.map((b) => b.status), ['other_region', 'current']);
    // The price step counts every region.
    assert.equal(us.tierLeft, 60);
  });

  it('keeps an EU buyer on paid batch 1', () => {
    const eu = campaignState(EU_FIRST, [{region: 'EU', units: 30}, {region: 'US', units: 10}], PENDING, TIERS, 49, 'EU');
    assert.equal(eu.batch, 1);
    assert.equal(eu.paidStock, true);
    assert.equal(eu.paidLeft, 220);
    assert.equal(eu.shipPromise, 'ships early November 2026');
    assert.equal(eu.ordered, 40);
    assert.equal(promiseBatchMonth(eu.shipPromise), 'November 2026');
  });

  it('allocates in order: US units fill batch 2, EU units past batch 1 follow', () => {
    assert.deepEqual(batchFill(EU_FIRST, [{region: 'US', units: 5}, {region: 'EU', units: 260}, {region: 'US', units: 1}]), [250, 16]);
    // Without regions the fill is the old global count.
    assert.deepEqual(batchFill([{units: 250, paid: true, ships: 'x'}, {units: 250}], 300), [250, 50]);
    // Funding target counts US units too.
    assert.equal(campaignState(EU_FIRST, [{region: 'US', units: 250}], PENDING, TIERS).targetReached, true);
  });

  it('never lets a US buyer take batch-1 FC/ESC stock, however empty batch 2 is or full batch 1 is', () => {
    const eu = ['OPENFC-LITE-2020', 'OPENFC-LITE-3030', 'OPENESC-2020', 'OPENESC-3030'];
    for (const sku of eu) {
      const batches = REAL.skus[sku].batches;
      assert.deepEqual(batches[0].regions, ['EU'], `${sku} batch 1 is EU only`);
      assert.equal(batches[0].paid, true);
      assert.equal(batches[0].ships, 'ships early November 2026');
      for (const ordered of [0, 1, 249, 250, 400]) {
        const us = campaignState(batches, [{region: 'US', units: ordered}], REAL.pendingShips, [], null, 'US');
        assert.notEqual(us.batch, 1, `${sku}: a US unit never lands in batch 1 (${ordered} US units ordered)`);
        assert.equal(us.paidStock, false);
        assert.ok(!/November 2026/.test(us.shipPromise), 'a US promise never names the early-November batch');
      }
      // US units do not use up batch-1 stock.
      assert.deepEqual(batchFill(batches, [{region: 'US', units: 100}]), [0, 100]);
      // The last batch of every SKU serves the US, so the US can always buy the run.
      assert.equal(batches[batches.length - 1].regions, undefined);
    }
    // Only the four FC/ESC SKUs carry Belgian batch-1 stock.
    for (const [sku, entry] of Object.entries(REAL.skus)) {
      if (!eu.includes(sku)) assert.ok(entry.batches.every((b) => !b.regions), `${sku} has no EU-only batch`);
    }
  });

  it('never gives a US unit Belgian accessory stock or an EU-only pinned batch', () => {
    const lead = REAL.skus['OPENFC-LITE-2020'].batches;
    const stockRule = REAL.shipsWith!['ACC-ANT-T'];
    const pinned = REAL.shipsWith!['ACC-STRAP-20X220'];
    const euStock = shipsWithState(REAL, stockRule, 10, 5, 0, 'EU');
    assert.equal(euStock.batch, 1);
    assert.equal(euStock.paidStock, true);
    const usStock = shipsWithState(REAL, stockRule, 10, 5, 0, 'US');
    assert.equal(usStock.batch, 2);
    assert.equal(usStock.paidStock, false);
    const usPinned = shipsWithState(REAL, pinned, 10, 5, 0, 'US');
    assert.equal(usPinned.batch, 2);
    assert.equal(usPinned.shipPromise, campaignState(lead, 10, REAL.pendingShips, [], null, 'US').shipPromise);
  });
});

function variant(partial: Partial<CatalogVariant> & {sku: string}): CatalogVariant {
  return {
    title: partial.sku, model: null, options: {}, price: 39.2, compare_price: 49, currency: 'EUR',
    availability: 'preorder', ship_promise: null, image: null, url: '/products/x',
    cart_add_url: '/api/shopify/cart', merchandise_id: `gid://shopify/ProductVariant/${partial.sku}`,
    ...partial,
  };
}

function catalogOf(variants: CatalogVariant[], currency = 'EUR'): Catalog {
  return {
    schema: 1, generated_at: '2026-10-01T00:00:00Z', max_age: 0, currency, prices_include_vat: currency === 'EUR',
    shop_url: 'https://s.myshopify.com', cart_url: 'https://s.myshopify.com', add_url: '/api/shopify/cart', add_method: 'POST',
    products: [{handle: 'openesc', title: 'OpenESC', family: null, description: null, url: '/products/openesc', images: [], rating: null, variants}],
  };
}

describe('US market prices', () => {
  it('shows a US buyer the USD price and the March promise while batch 1 has units', () => {
    const eur = catalogOf([variant({sku: 'OPENESC-2020', price: 39.2, compare_price: 49})]);
    const usd = catalogOf([variant({sku: 'OPENESC-2020', price: 53, compare_price: 66.3, currency: 'USD'})], 'USD');
    const eu = applyCampaign(eur, REAL, {'OPENESC-2020': 12}, OPEN, 'EU').products[0].variants[0];
    assert.equal(eu.currency, 'EUR');
    assert.match(eu.ship_promise ?? '', /November 2026/);
    const us = withMarketPrices(applyCampaign(eur, REAL, {'OPENESC-2020': 12}, OPEN, 'US'), usd);
    const v = us.products[0].variants[0];
    assert.equal(us.currency, 'USD');
    assert.equal(us.prices_include_vat, false);
    assert.equal(v.price, 53);
    assert.equal(v.currency, 'USD');
    assert.equal(v.availability, 'preorder');
    assert.match(v.ship_promise ?? '', /31 March 2027/);
    assert.equal(v.campaign?.batch, 2);
    assert.equal(v.campaign?.paidStock, false);
    // Shopify's US price, and no derived next step.
    assert.equal(v.campaign?.price, 53);
    assert.equal(v.campaign?.nextPrice, null);
    assert.doesNotMatch(v.ship_promise ?? '', /delivered/i);
    assert.doesNotMatch(eu.ship_promise ?? '', /delivered/i);
  });

  it('closes a variant the US read does not price in USD, and everything without a US read', () => {
    const eur = catalogOf([variant({sku: 'A'}), variant({sku: 'B'})]);
    const usd = catalogOf([variant({sku: 'A', price: 50, currency: 'USD'})], 'USD');
    const [a, b] = withMarketPrices(eur, usd).products[0].variants;
    assert.equal(a.availability, 'preorder');
    assert.equal(b.availability, 'sold_out');
    const none = withMarketPrices(eur, null);
    assert.ok(none.products[0].variants.every((x) => x.availability === 'sold_out' && x.currency === 'EUR'));
    assert.equal(none.currency, 'EUR');
  });

  it('shows a variant the US market does not sell as sold out at its USD price', () => {
    const eur = catalogOf([variant({sku: 'A'})]);
    const usd = catalogOf([variant({sku: 'A', price: 53, currency: 'USD', availability: 'sold_out'})], 'USD');
    const [a] = withMarketPrices(eur, usd).products[0].variants;
    assert.equal(a.availability, 'sold_out');
    assert.equal(a.price, 53);
    assert.equal(a.currency, 'USD');
  });

  it('accepts USD only on the US market read', () => {
    const data = {products: {pageInfo: {hasNextPage: false}, nodes: [{
      handle: 'x', title: 'X', description: '', productType: '', vendor: null, featuredImage: null,
      images: {nodes: []}, rating: null, ratingCount: null,
      variants: {pageInfo: {hasNextPage: false}, nodes: [{
        id: 'gid://shopify/ProductVariant/1', title: 'X', sku: 'X', availableForSale: true, image: null,
        price: {amount: '53.00', currencyCode: 'USD'}, compareAtPrice: null, selectedOptions: [],
      }]},
    }]}};
    const policy = JSON.stringify({X: {saleMode: 'preorder', shipPromise: null}});
    assert.throws(() => mapShopifyCatalog(data, 's.myshopify.com', policy, '1'), /not priced in EUR/);
    const us = mapShopifyCatalog(data, 's.myshopify.com', policy, '1', 'US');
    assert.equal(us.currency, 'USD');
    assert.equal(us.products[0].variants[0].price, 53);
  });
});

const ENV = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0', PUBLIC_US_SALES: '1'} as const;
const CHECKOUT = 'https://checkout.opendrone.be/checkouts/cn/ok';

function post(values: Record<string, string>, country: string): Request {
  return new Request('https://opendrone.be/api/shopify/cart', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be', 'CF-IPCountry': country},
    body: new URLSearchParams(values),
  });
}

function emptyCart(currencyCode = 'USD'): ShopifyCart {
  return {id: 'gid://shopify/Cart/a', checkoutUrl: CHECKOUT, totalQuantity: 0,
    subtotal: {amount: '0', currencyCode}, total: {amount: '0', currencyCode}, lines: []};
}

/** The OpenFC Lite 20x20 (a campaign preorder, EU batch 1 open) and an
 *  in-stock item, as the US catalog shows them. */
function usCatalog(): Catalog {
  const eur = catalogOf([]);
  eur.products = [
    {handle: 'openfc-lite', title: 'OpenFC Lite', family: null, description: null, url: '/products/openfc-lite', images: [], rating: null,
      variants: [variant({sku: 'OPENFC-LITE-2020', price: 31.2, compare_price: 39})]},
    {handle: 'openrx', title: 'OpenRX', family: null, description: null, url: '/products/openrx', images: [], rating: null,
      variants: [variant({sku: 'OPENRX-LITE', availability: 'in_stock', ship_promise: null})]},
    {handle: 'other', title: 'Other', family: null, description: null, url: '/products/other', images: [], rating: null,
      variants: [
        variant({sku: 'ACC-NEW-THING', availability: 'in_stock', ship_promise: null, price: 4, compare_price: null}),
        variant({sku: 'ACC-GONE', availability: 'sold_out', ship_promise: null, price: 4, compare_price: null}),
      ]},
  ];
  return applyCampaign(eur, REAL, {'OPENFC-LITE-2020': 3}, OPEN, 'US');
}

describe('US cart with the gate on', () => {
  it('adds a campaign preorder with the US promise, the hidden region and a US cart', async () => {
    let added: CartLineInput[] = [];
    let country: string | undefined;
    const response = await handleShopifyCartAction(post({sku: 'OPENFC-LITE-2020', qty: '2'}, 'US'), ENV, {
      fetchCatalog: async () => usCatalog(),
      createCart: async (lines, code) => { added = lines; country = code; return emptyCart(); },
    });
    assert.equal(response.status, 303);
    assert.equal(country, 'US');
    assert.equal(added[0].quantity, 2);
    const attrs = Object.fromEntries((added[0].attributes ?? []).map((a) => [a.key, a.value]));
    assert.match(attrs.Preorder, /31 March 2027/);
    assert.equal(attrs._ship_region, 'US');
  });

  it('sells an in-stock SKU to a US destination as a preorder of the March batch', async () => {
    let added: CartLineInput[] = [];
    await handleShopifyCartAction(post({sku: 'ACC-NEW-THING', qty: '1'}, 'US'), ENV, {
      fetchCatalog: async () => usCatalog(),
      createCart: async (lines) => { added = lines; return emptyCart(); },
    });
    const attrs = Object.fromEntries((added[0].attributes ?? []).map((a) => [a.key, a.value]));
    assert.match(attrs.Preorder, /31 March 2027/);
    assert.doesNotMatch(attrs.Preorder, /delivered/i);
    assert.equal(attrs._ship_region, 'US');
  });

  it('still refuses what is sold out for a US destination', async () => {
    const error = await handleShopifyCartAction(post({sku: 'ACC-GONE', qty: '1'}, 'US'), ENV, {
      fetchCatalog: async () => usCatalog(),
      createCart: async () => { throw new Error('must not create'); },
    }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof Response);
    assert.equal(error.status, 409);
  });

  it('keeps the US closed when the rate is null, even with the gate on', async () => {
    // The add behaves as on main: no US cart, no US line, and checkout refuses.
    let added: CartLineInput[] = [];
    let country: string | undefined = 'unset';
    await handleShopifyCartAction(post({sku: 'OPENFC-LITE-2020', qty: '1'}, 'US'), ENV, {
      usRate: null,
      fetchCatalog: async () => usCatalog(),
      createCart: async (lines, code) => { added = lines; country = code; return emptyCart('EUR'); },
    });
    assert.equal(country, undefined);
    assert.ok(!(added[0].attributes ?? []).some((a) => a.key === '_ship_region'));
    const error = await handleShopifyCartAction(post({intent: 'checkout'}, 'US'), ENV, {
      usRate: null,
      fetchCatalog: async () => usCatalog(),
      createCart: async () => { throw new Error('must not create'); },
      getCartId: () => 'c',
    }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof Response);
    assert.equal(error.status, 403);
  });

  it('moves a EUR cart to the US market at checkout and shows the cart again', async () => {
    const calls: string[] = [];
    const line = {
      id: 'gid://shopify/CartLine/1', merchandiseId: 'gid://shopify/ProductVariant/OPENFC-LITE-2020', quantity: 1,
      title: 'OpenFC Lite', variantTitle: '20x20', handle: 'openfc-lite', sku: 'OPENFC-LITE-2020', image: null,
      selectedOptions: [], shipPromise: 'ships early November 2026', total: {amount: '31.2', currencyCode: 'EUR'},
    };
    const response = await handleShopifyCartAction(post({intent: 'checkout'}, 'US'), ENV, {
      fetchCatalog: async () => usCatalog(),
      createCart: async () => { throw new Error('must not create'); },
      getCartId: () => 'gid://shopify/Cart/a',
      getCart: async () => ({...emptyCart('EUR'), totalQuantity: 1, lines: [line]}),
      setCountry: async (_id, code) => { calls.push(`country:${code}`); },
      updateCartLines: async (_id, lines) => { calls.push(`update:${lines[0].attributes?.map((a) => a.key).join('+')}`); return emptyCart(); },
    });
    assert.equal(response.headers.get('Location'), '/cart?check=market');
    assert.deepEqual(calls, ['country:US', 'update:Preorder+_ship_region']);
  });

  it('puts the US on the cart from the cart country picker', async () => {
    const set: string[] = [];
    const response = await handleCartCountry(
      new Request('https://opendrone.be/api/shopify/cart-country', {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be'},
        body: new URLSearchParams({country: 'US'}),
      }),
      ENV,
      {getCartId: () => 'c', setCountry: async (_id, code) => { set.push(code); }},
    );
    assert.deepEqual(await response.json(), {country: 'US', applied: true});
    assert.deepEqual(set, ['US']);
  });
});

describe('FCC conditional-sale disclosure', () => {
  it('applies to the receivers only', () => {
    for (const sku of ['OPENRX-LITE', 'OPENRX-LITE-UFL', 'OPENRX-MONO', 'OPENRX-GEMINI', 'openrx']) {
      assert.equal(fccConditionalSku(sku), true, sku);
    }
    for (const sku of ['OPENFC-LITE-2020', 'OPENESC-3030', 'OPENFRAME-5', 'ACC-ANT-T', '', null, undefined]) {
      assert.equal(fccConditionalSku(sku), false, String(sku));
    }
  });

  it('carries the 2.803 wording in the product copy, en only, with the refund line', () => {
    for (const [file, key] of [['product-chrome', 'buy_us_fcc']] as const) {
      const copy = JSON.parse(fs.readFileSync(new URL(`../../content/copy/${file}.json`, import.meta.url), 'utf8')) as Record<string, string>;
      const text: string = copy[key];
      assert.match(text, /has not been authorized as required by the rules of the Federal Communications Commission/);
      assert.match(text, /conditional preorder/);
      assert.match(text, /not delivered unless authorization is obtained/);
      assert.match(text, /FCC rules do not address consumer protection, contractual or other provisions under federal or state law/);
      assert.match(text, /we refund that item in full/);
      assert.ok(!text.includes('\u2014'));
    }
  });

  it('keeps the full FCC notice on the product page and a short linked line in the cart', () => {
    const read = (file: string) => JSON.parse(fs.readFileSync(new URL(`../../content/copy/${file}.json`, import.meta.url), 'utf8')) as Record<string, string>;
    const chrome = read('product-chrome');
    const cart = read('cart');
    assert.equal(cart.fcc_line, 'Not yet FCC authorized. Refund if not authorized.');
    assert.equal(cart.us_fcc, undefined);
    assert.equal(cart.us_notice, undefined);
    assert.match(chrome.buy_us_notice, /FCC equipment authorization and US import clearance/);
  });
});

/** Live Shopify pairs (EUR price, US contextual price, both whole dollars,
 *  read 2026-09-30): eur, usd, compare-at eur, compare-at usd. */
const LIVE: Array<[number, number, number | null, number | null]> = [
  [39.2, 57, 49, 71], [47.2, 69, 59, 86], [16.8, 25, 21, 31], [21.6, 32, 27, 40], [28.8, 42, 36, 53],
  [31.2, 46, 39, 57], [23.2, 34, 29, 42], [15.2, 22, 19, 28], [19.2, 28, 24, 35],
  [2, 3, null, null], [4.5, 7, null, null], [5.5, 8, null, null], [7.5, 11, null, null], [5, 8, null, null],
  [1, 2, null, null], [1.5, 3, null, null], [2.9, 5, null, null], [3.9, 6, null, null], [6, 9, null, null], [8, 12, null, null],
];
const LIVE_SAMPLES = LIVE.flatMap(([eur, usd, ce, cu]) => [{eur, usd}, ...(ce != null && cu != null ? [{eur: ce, usd: cu}] : [])]);

describe('US price ladder', () => {
  it('finds the live rounding (up to whole dollars) and a factor band from the live prices', () => {
    const band = usdBand(LIVE_SAMPLES)!;
    assert.equal(band.mode, 'ceil');
    // +25% and Shopify's FX: about 1.445 USD per EUR incl. VAT.
    assert.ok(band.lo > 1.44 && band.hi < 1.45 && band.lo < band.hi);
  });

  it('reproduces every live USD price from its EUR price', () => {
    const band = usdBand(LIVE_SAMPLES)!;
    for (const {eur, usd} of LIVE_SAMPLES) {
      const got = usdOf(eur, band);
      assert.equal(got.price, usd, `${eur} EUR`);
      assert.equal(got.approx, false, `${eur} EUR`);
    }
  });

  it('gives OpenESC 30x30 the live current step, an exact retail step and marks a step it cannot prove', () => {
    const band = usdBand(LIVE_SAMPLES)!;
    const ladder = usdLadder(59, TIERS, band, 2, 69);
    assert.deepEqual(ladder.map((s) => s.from), [1, 101, 251]);
    // Unit 2 is in step 1: Shopify's live US price, never an estimate.
    assert.equal(ladder[0].price, 69);
    assert.equal(ladder[0].approx, false);
    // Retail (59 EUR) is the live compare-at price: 86 USD.
    assert.equal(ladder[2].price, 86);
    assert.equal(ladder[2].approx, false);
    assert.ok(ladder[1].price > 69 && ladder[1].price < 86);
    // A band wide enough to straddle a whole dollar labels the step "about".
    const wide = usdOf(53.1, {lo: 1.3, hi: 1.6, mode: 'ceil'});
    assert.equal(wide.approx, true);
  });

  it('shows no ladder when no factor explains the live prices', () => {
    assert.equal(usdBand([{eur: 10, usd: 15}, {eur: 10, usd: 30}]), null);
    assert.equal(usdBand([]), null);
  });

  it('puts the ladder on a US campaign variant and keeps Shopify price as the current step', () => {
    const eur = catalogOf(LIVE.slice(0, 3).map(([price, , compare], i) =>
      variant({sku: ['OPENESC-2020', 'OPENESC-3030', 'OPENRX-LITE'][i], price, compare_price: compare})));
    const usd = catalogOf(LIVE.slice(0, 3).map(([, price, , compare], i) =>
      variant({sku: ['OPENESC-2020', 'OPENESC-3030', 'OPENRX-LITE'][i], price, compare_price: compare, currency: 'USD'})), 'USD');
    const camp = applyCampaign(eur, REAL, {'OPENESC-3030': 1}, OPEN, 'US');
    const us = withMarketPrices(camp, usd, REAL).products[0].variants.find((v) => v.sku === 'OPENESC-3030')!;
    const ladder = us.campaign!.usLadder!;
    assert.equal(ladder.length, 3);
    assert.equal(ladder[0].price, us.price);
    assert.equal(ladder[0].price, 69);
    assert.equal(ladder[2].price, 86);
    // Without the campaign config nothing changes: no ladder.
    assert.equal(withMarketPrices(camp, usd).products[0].variants[1].campaign?.usLadder, undefined);
  });
});

describe('US price uplift source', () => {
  it('commits the uplift Shopify holds and compares it with the price list', () => {
    assert.equal(readUpliftPct(new URL('../../content/us-sales.json', import.meta.url).pathname), 25);
    assert.equal(US_SALES.priceUpliftPct, 25);
    const list = {
      id: 'gid://shopify/PriceList/1', name: 'United States USD, duties included (+25%)', currency: 'USD',
      parent: {adjustment: {type: 'PERCENTAGE_INCREASE', value: 25}},
    };
    assert.equal(planUplift(list, 25), null);
    assert.deepEqual(planUplift(list, 30), {
      id: list.id, from: 25, to: 30,
      name: {from: list.name, to: 'United States USD, duties included (+30%)'},
    });
    assert.equal(nameWithUplift('US list', 30), 'US list (+30%)');
    const eurList = {id: 'e', name: 'EU', currency: 'EUR', parent: {adjustment: {type: 'PERCENTAGE_DECREASE', value: 0}}};
    assert.equal(findUsList([eurList, list]).id, list.id);
    assert.throws(() => findUsList([eurList]), /exactly one/);
  });
});

describe('every product is purchasable by a US ship-to', () => {
  const NOW = OPEN;
  const skus = [...Object.keys(REAL.skus), ...Object.keys(REAL.shipsWith ?? {}), 'ACC-NOT-LISTED'];

  /** One variant per SKU in the given sale mode, priced in EUR and in USD. */
  function pair(mode: CatalogVariant['availability']) {
    const eur = catalogOf(skus.map((sku) => variant({sku, availability: mode, ship_promise: null, price: 10, compare_price: null})));
    const usd = catalogOf(skus.map((sku) => variant({sku, availability: mode, ship_promise: null, price: 15, compare_price: null, currency: 'USD'})), 'USD');
    return {eur, usd};
  }

  for (const mode of ['preorder', 'in_stock'] as const) {
    it(`sells every ${mode} SKU, campaign or not, to the US with the March promise`, () => {
      const {eur, usd} = pair(mode);
      const us = withMarketPrices(applyCampaign(eur, REAL, {}, NOW, 'US'), usd, REAL);
      for (const v of us.products[0].variants) {
        assert.equal(v.availability, 'preorder', v.sku);
        assert.ok(usSellable(v), `${v.sku} must stay purchasable for a US ship-to`);
        assert.equal(v.currency, 'USD', v.sku);
        assert.match(v.ship_promise ?? '', /31 March 2027/, v.sku);
        assert.doesNotMatch(v.ship_promise ?? '', /delivered/i);
        assert.ok(v.campaign && !v.campaign.paidStock, v.sku);
      }
    });
  }

  it('keeps Belgian stock EU only and leaves the EU catalog unchanged', () => {
    const {eur} = pair('in_stock');
    const eu = applyCampaign(eur, REAL, {}, NOW, 'EU');
    assert.ok(eu.products[0].variants.every((v) => v.availability === 'in_stock' && !usSellable(v)));
    // Batch 1 FC/ESC paid stock is EU only, and the US still buys them from batch 2.
    const preorder = pair('preorder');
    const eu2 = applyCampaign(preorder.eur, REAL, {'OPENESC-3030': 1}, NOW, 'EU').products[0].variants.find((v) => v.sku === 'OPENESC-3030')!;
    assert.equal(eu2.campaign?.batch, 1);
    assert.equal(eu2.campaign?.paidStock, true);
    const us2 = applyCampaign(preorder.eur, REAL, {'OPENESC-3030': 1}, NOW, 'US').products[0].variants.find((v) => v.sku === 'OPENESC-3030')!;
    assert.equal(us2.campaign?.batch, 2);
    assert.ok(usSellable(us2));
  });

  it('keeps a sold-out SKU sold out', () => {
    const {eur, usd} = pair('sold_out');
    const us = withMarketPrices(applyCampaign(eur, REAL, {}, NOW, 'US'), usd, REAL);
    assert.ok(us.products[0].variants.every((v) => v.availability === 'sold_out'));
  });

  it('commits a usStock rule that serves the US', () => {
    assert.deepEqual(REAL.usStock, {sku: 'OPENFC-LITE-2020', batch: 2});
    const base = {countFrom: '2026-09-25', endsOn: '2026-12-15', shipsBy: '2027-03-31', priceTiers: TIERS, pendingShips: PENDING};
    assert.throws(() => parseCampaignConfig({...base, skus: {A: {batches: EU_FIRST}}, usStock: {sku: 'A', batch: 1}}), /serve the US/);
    assert.throws(() => parseCampaignConfig({...base, skus: {A: {batches: EU_FIRST}}, usStock: {sku: 'B', batch: 2}}), /usStock/);
  });
});
