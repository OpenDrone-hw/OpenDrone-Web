import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {bySku, offerSaving, preorderView, variantByMerchandise, type Catalog} from './catalog.ts';
import {boardExpressLines, buildAddonTotal, buildAddonUrl, buildForPart, buildModes, expressLinesField, fullBuildHref, partnerBoard, heroBuildSelection, modeAddUrl, resolveHeroBuilds, stackOffer} from './hero-build.ts';
import {parseBuilds} from './build-recommendations.ts';
import {applyCampaign, parseCampaignConfig, preorderChoiceLine, shipsOnlyWithPaid, type CampaignConfig} from './preorder-campaign.ts';
import {assignBatches, batchPromiseMismatch, batchTag, type PreorderOrder} from './preorder-fulfilment.ts';
import {
  CART_CHECK,
  EXPRESS_INTENT,
  EXPRESS_PARAM,
  EXPRESS_REFUSED,
  batchChoiceConflict,
  buyNowToPreorder,
  cartCurrencyMisses,
  cartLineInfo,
  sellsBuyNow,
  expressLines,
  handleShopifyCartAction as actualCartAction,
  splitPlan,
  type ShopifyCartDependencies,
} from './shopify-cart-action.ts';
import {fetchPaidUnitRuns} from './shopify-orders.ts';
import {batchChoiceOn, mapShopifyCatalog, type CartLineInput, type ShopifyCart, type ShopifyCartLine} from './shopify-storefront.ts';
import {choiceCatalogData, CHOICE_IDS, CHOICE_POLICY} from './batch-choice-fixture.ts';

/**
 * Buy now or pre-order (`BATCH_CHOICE`): a board is two Shopify variants
 * with one SKU. These tests hold the rules a buyer's money depends on:
 * the flag off changes nothing, an unknown or badly paired SKU still fails
 * closed, each variant counts as what it sold, and no checkout pays retail
 * for a board that ships in March.
 */

const CONFIG: CampaignConfig = {
  ...parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8'))),
  choiceFrom: '2026-11-20T10:00:00Z',
};
const NOW = new Date('2026-11-21T12:00:00Z');
const FC = 'OPENFC-LITE-2020';
const FC30 = 'OPENFC-LITE-3030';

const map = (on: boolean, data = choiceCatalogData()) =>
  mapShopifyCatalog(data, 'open-drone-test.myshopify.com', JSON.stringify(CHOICE_POLICY), '1', 'default', on);
const live = (ordered: Record<string, number> = {}, region: 'EU' | 'US' | 'NEAR' | 'INT' = 'EU', on = true): Catalog =>
  applyCampaign(map(on), CONFIG, ordered, NOW, region);

describe('catalog: two Batch variants fold into one board', () => {
  it('reads the flag as on only for exactly "1"', () => {
    assert.equal(batchChoiceOn({BATCH_CHOICE: '1'}), true);
    for (const value of ['0', '', 'true', 'preview', undefined]) assert.equal(batchChoiceOn({BATCH_CHOICE: value}), false);
  });

  it('keeps one entry per SKU, without the Batch option, whatever the flag', () => {
    for (const on of [false, true]) {
      const boards = map(on).products.find((p) => p.handle === 'openfc-lite')!;
      assert.deepEqual(boards.variants.map((v) => [v.sku, v.title, v.options]), [
        [FC, '20×20', {Model: '20×20'}],
        [FC30, '30×30', {Model: '30×30'}],
      ]);
      assert.equal(boards.variants[0].merchandise_id, CHOICE_IDS[FC].preorder);
      assert.equal(boards.variants[0].price, 26.1);
    }
  });

  it('flag off: the catalog is the one Shopify had before the Buy now variants existed', () => {
    const before = mapShopifyCatalog(choiceCatalogData({withChoice: false}), 'open-drone-test.myshopify.com', JSON.stringify(CHOICE_POLICY), '1');
    const strip = (c: Catalog) => ({...c, generated_at: ''});
    assert.deepEqual(strip(map(false)), strip(before));
    assert.deepEqual(strip(applyCampaign(map(false), CONFIG, {}, NOW)), strip(applyCampaign(before, CONFIG, {}, NOW)));
  });

  it('flag on: the Buy now variant rides on its board', () => {
    assert.deepEqual(bySku(map(true), FC)!.variant.buy_now, {merchandise_id: CHOICE_IDS[FC].buyNow, price: 29, available: true});
  });

  it('still fails closed on a duplicate, unpaired or unknown SKU', () => {
    const broken = (edit: (data: ReturnType<typeof choiceCatalogData>) => void) => {
      const data = choiceCatalogData();
      edit(data);
      return () => map(true, data);
    };
    const fc = (data: ReturnType<typeof choiceCatalogData>) => data.products.nodes.find((p) => p.handle === 'openfc-lite')!.variants.nodes;
    // Two Buy now variants of one SKU.
    assert.throws(broken((d) => { fc(d).push({...fc(d).find((v) => v.id === CHOICE_IDS[FC].buyNow)!, id: 'gid://shopify/ProductVariant/dup'}); }), /duplicate SKU/);
    // Two pre-order variants of one SKU.
    assert.throws(broken((d) => { fc(d).push({...fc(d)[0], id: 'gid://shopify/ProductVariant/dup'}); }), /duplicate SKU/);
    // A Buy now variant whose pre-order variant is gone.
    assert.throws(broken((d) => { fc(d).splice(0, 1); }), /without its Pre-order variant/);
    // A Buy now variant on another product than its board.
    assert.throws(broken((d) => {
      const [moved] = fc(d).splice(fc(d).findIndex((v) => v.id === CHOICE_IDS[FC].buyNow), 1);
      d.products.nodes.find((p) => p.handle === 'openesc')!.variants.nodes.push(moved);
    }), /without its Pre-order variant/);
    // A Batch value the site does not know.
    assert.throws(broken((d) => { fc(d)[0].selectedOptions[1].value = 'Later'; }), /unknown Batch value/);
    // A SKU with no catalog policy, flag on or off.
    assert.throws(broken((d) => { fc(d)[0].sku = 'OPENFC-NEW'; fc(d).find((v) => v.id === CHOICE_IDS[FC].buyNow)!.sku = 'OPENFC-NEW'; }), /missing catalog policy/);
    assert.throws(() => mapShopifyCatalog(choiceCatalogData({withChoice: false, extraSku: 'MYSTERY-1'}), 'open-drone-test.myshopify.com', JSON.stringify(CHOICE_POLICY), '1'), /missing catalog policy/);
  });
});

describe('offers: buy now at retail, pre-order at the early price', () => {
  it('EU, stock left: buy now is the primary offer and pre-order sits beside it', () => {
    const board = bySku(live({[FC]: 150}), FC)!.variant;
    assert.equal(board.offer, 'buy_now');
    assert.equal(board.merchandise_id, CHOICE_IDS[FC].buyNow);
    assert.equal(board.price, 29);
    assert.equal(board.compare_price, null);
    assert.equal(board.campaign?.paidStock, true);
    assert.equal(board.campaign?.inStock, true);
    assert.equal(board.campaign?.paidLeft, 50);
    assert.equal(board.campaign?.earlyPrice, false);
    assert.equal(board.buy_now, undefined);
    const preorder = board.preorder_offer!;
    assert.equal(preorder.merchandise_id, CHOICE_IDS[FC].preorder);
    assert.equal(preorder.price, 26.1);
    assert.equal(preorder.compare_price, 29);
    assert.equal(preorder.ship_promise, 'ships by 31 March 2027');
    assert.equal(preorder.campaign?.paidStock, false);
    assert.equal(preorder.campaign?.batch, 2);
    assert.equal(preorder.campaign?.shipByDay, '2027-03-31');
  });

  it('a board already at retail costs the same either way', () => {
    const board = bySku(live(), FC30)!.variant;
    assert.equal(board.price, 39);
    assert.equal(board.preorder_offer?.price, 39);
    assert.equal(board.preorder_offer?.compare_price, null);
  });

  it('outside the EU, at zero stock, or when Shopify denies it: pre-order only, from the March batch', () => {
    const cases: Array<[string, Catalog]> = [
      ['US', live({}, 'US')],
      ['batch 1 sold', live({[FC]: 200})],
      ['Shopify out of stock', applyCampaign(map(true, choiceCatalogData({buyNowAvailable: false})), CONFIG, {[FC]: 10}, NOW)],
    ];
    for (const [name, catalog] of cases) {
      const board = bySku(catalog, FC)!.variant;
      assert.equal(board.offer, 'preorder', name);
      assert.equal(board.preorder_offer, undefined, name);
      assert.equal(board.merchandise_id, CHOICE_IDS[FC].preorder, name);
      assert.equal(board.campaign?.paidStock, false, name);
      assert.equal(board.ship_promise, 'ships by 31 March 2027', name);
      assert.equal(variantByMerchandise(catalog, CHOICE_IDS[FC].buyNow), null, name);
    }
  });

  it('the pre-order variant never takes batch 1 stock while the choice is on', () => {
    // 10 units sold: stock is left, but the pre-order side is batch 2.
    const board = bySku(live({[FC]: 10}), FC)!.variant;
    assert.equal(preorderView(board)!.campaign?.batch, 2);
    assert.equal(preorderView(board)!.campaign?.paidStock, false);
  });

  it('finds each offer by its own Shopify variant id', () => {
    const catalog = live();
    assert.equal(variantByMerchandise(catalog, CHOICE_IDS[FC].buyNow)!.variant.offer, 'buy_now');
    const preorder = variantByMerchandise(catalog, CHOICE_IDS[FC].preorder)!.variant;
    assert.equal(preorder.offer, 'preorder');
    assert.equal(preorder.price, 26.1);
    assert.match(preorder.cart_add_url, /offer=preorder/);
  });
});

describe('paid units: each variant counts as what it sold', () => {
  const at = (iso: string, title: string) => preorderChoiceLine(CONFIG, {variantTitle: title}, iso);

  it('a Pre-order variant line is a March unit only from choiceFrom on', () => {
    assert.equal(at('2026-11-20T10:00:00Z', '20×20 / Pre-order'), true);
    assert.equal(at('2026-11-20T09:59:59Z', '20×20 / Pre-order'), false);
    assert.equal(at('2026-11-25T00:00:00Z', '20×20 / Buy now'), false);
    assert.equal(at('2026-11-25T00:00:00Z', '20×20'), false);
    assert.equal(preorderChoiceLine({}, {variantTitle: '20×20 / Pre-order'}, '2026-11-25T00:00:00Z'), false);
  });

  it('one pre-order board makes the whole order a March order', () => {
    assert.equal(shipsOnlyWithPaid(CONFIG, [{sku: FC, quantity: 1}, {sku: 'OPENESC-2020', quantity: 1}]), true);
    assert.equal(shipsOnlyWithPaid(CONFIG, [{sku: FC, quantity: 1, preorder: true}, {sku: 'OPENESC-2020', quantity: 1}]), false);
  });

  it('the paid counts read the recorded variant title per line', async () => {
    const node = (createdAt: string, title: string, quantity: number) => ({
      test: false, createdAt, cancelledAt: null, displayFinancialStatus: 'PAID',
      shippingAddress: {countryCodeV2: 'BE'},
      lineItems: {pageInfo: {hasNextPage: false}, nodes: [{sku: FC, variantTitle: title, currentQuantity: quantity, customAttributes: []}]},
    });
    const fetcher = (async () => new Response(JSON.stringify({data: {orders: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: [
      node('2026-11-01T10:00:00Z', '20×20', 3),
      node('2026-11-20T09:00:00Z', '20×20 / Pre-order', 2),
      node('2026-11-21T09:00:00Z', '20×20 / Buy now', 4),
      node('2026-11-21T10:00:00Z', '20×20 / Pre-order', 5),
    ]}}}))) as unknown as typeof fetch;
    const runs = await fetchPaidUnitRuns(
      {SHOPIFY_STORE_DOMAIN: 'open-drone-test.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'test-token'} as Env,
      CONFIG.countFrom, new Set([FC]), fetcher, CONFIG,
    );
    // 3 + 2 (sold as stock before the choice) + 4 buy now take batch 1; 5 are March units.
    assert.deepEqual(runs[FC], [{region: 'EU', units: 9}, {region: 'EU', units: 5, march: true}]);
    assert.equal(bySku(applyCampaign(map(true), CONFIG, runs, NOW), FC)!.variant.campaign?.paidLeft, 191);
  });

  const order = (id: number, createdAt: string, lines: Array<[string, string, number]>, attributes: Array<{key: string; value: string}> = []): PreorderOrder => ({
    id: `gid://shopify/Order/${id}`, name: `#${id}`, createdAt, test: false, cancelledAt: null,
    displayFinancialStatus: 'PAID', tags: [], email: null, customerLocale: null,
    shippingAddress: {countryCodeV2: 'BE'},
    lineItems: {pageInfo: {hasNextPage: false}, nodes: lines.map(([sku, variantTitle, currentQuantity]) => ({sku, name: sku, variantTitle, currentQuantity, customAttributes: attributes}))},
    fulfillmentOrders: {nodes: []},
  } as unknown as PreorderOrder);

  it('the hold pass writes batch 1 for Buy now and batch 2 for Pre-order, same SKU string', () => {
    const buyNow = order(1, '2026-11-21T09:00:00Z', [[FC, '20×20 / Buy now', 1]]);
    const preorder = order(2, '2026-11-21T10:00:00Z', [[FC, '20×20 / Pre-order', 1]]);
    const before = order(3, '2026-11-19T10:00:00Z', [[FC, '20×20 / Pre-order', 1]]);
    const batches = assignBatches([buyNow, preorder, before], CONFIG);
    const tags = (o: PreorderOrder) => batches.get(o.id)!.map((b) => batchTag(b.sku, b.batch));
    // The shipping runbook picks orders by exactly this tag.
    assert.deepEqual(tags(buyNow), [`batch:${FC}:1`]);
    assert.deepEqual(tags(preorder), [`batch:${FC}:2`]);
    assert.deepEqual(tags(before), [`batch:${FC}:1`]);
  });

  it('an express stack order counts down both Buy now boards', async () => {
    const fetcher = (async () => new Response(JSON.stringify({data: {orders: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: [{
      test: false, createdAt: '2026-11-21T09:00:00Z', cancelledAt: null, displayFinancialStatus: 'PAID', shippingAddress: {countryCodeV2: 'BE'},
      lineItems: {pageInfo: {hasNextPage: false}, nodes: [
        {sku: FC, variantTitle: '20×20 / Buy now', currentQuantity: 3, customAttributes: []},
        {sku: 'OPENESC-2020', variantTitle: '20×20 / Buy now', currentQuantity: 3, customAttributes: []},
      ]},
    }]}}}))) as unknown as typeof fetch;
    const runs = await fetchPaidUnitRuns(
      {SHOPIFY_STORE_DOMAIN: 'open-drone-test.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'test-token'} as Env,
      CONFIG.countFrom, new Set([FC, 'OPENESC-2020']), fetcher, CONFIG,
    );
    const after = applyCampaign(map(true), CONFIG, runs, NOW);
    assert.equal(bySku(after, FC)!.variant.campaign?.paidLeft, 197);
    assert.equal(bySku(after, 'OPENESC-2020')!.variant.campaign?.paidLeft, 197);
  });

  it('an express stack order: both boards take batch 1, tagged batch:<sku>:1', () => {
    const stack = order(7, '2026-11-21T12:00:00Z', [[FC, '20×20 / Buy now', 2], ['OPENESC-2020', '20×20 / Buy now', 2]]);
    const tags = assignBatches([stack], CONFIG).get(stack.id)!.map((b) => batchTag(b.sku, b.batch));
    assert.deepEqual(tags.sort(), ['batch:OPENESC-2020:1', `batch:${FC}:1`]);
  });

  it('flags a Buy now board that ended up in a March order', () => {
    const stock = [{key: 'Shipping', value: 'In stock in Belgium, ships in a few working days.'}, {key: '_ship_promise', value: 'in stock in Belgium, ships to EU addresses in a few working days'}, {key: '_batch', value: `${FC}:1`}];
    const raw = order(4, '2026-11-21T11:00:00Z', [[FC, '20×20 / Buy now', 1], ['OPENMOTOR-1604', '', 4]], stock);
    const batches = assignBatches([raw], CONFIG).get(raw.id)!;
    assert.deepEqual(batches.filter((b) => b.sku === FC).map((b) => b.batch), [2]);
    assert.equal(batchPromiseMismatch(raw, batches, CONFIG), true);
    const clean = order(5, '2026-11-21T12:00:00Z', [[FC, '20×20 / Buy now', 1]], stock);
    assert.equal(batchPromiseMismatch(clean, assignBatches([clean], CONFIG).get(clean.id)!, CONFIG), false);
  });
});

// ---------------------------------------------------------------- the cart

const APPROVED = Object.fromEntries(['BE', 'NL'].map((c) => [c, {saleApproved: true}]));
const handleShopifyCartAction: typeof actualCartAction = (request, env, deps) =>
  actualCartAction(request, env, {registrations: APPROVED, ...deps});
const ENV = {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0'} as const;
const CHECKOUT = 'https://checkout.opendrone.be/checkouts/cn/ok';
const STOCK_PROMISE = 'in stock in Belgium, ships to EU addresses in a few working days';
const MARCH = 'ships by 31 March 2027';

function request(values: Record<string, string | string[]>): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
  return new Request('https://opendrone.be/api/shopify/cart', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be', 'CF-IPCountry': 'BE'},
    body,
  });
}

function line(n: number, overrides: Partial<ShopifyCartLine>): ShopifyCartLine {
  return {
    id: `gid://shopify/CartLine/${n}?cart=a`, merchandiseId: 'x', quantity: 1, title: 'OpenFC Lite', variantTitle: '20×20',
    handle: 'openfc-lite', sku: FC, image: null, selectedOptions: [{name: 'Model', value: '20×20'}], shipPromise: null,
    total: {amount: '0.00', currencyCode: 'EUR'}, ...overrides,
  };
}
const buyNowLine = (n = 1, quantity = 1) => line(n, {merchandiseId: CHOICE_IDS[FC].buyNow, offer: 'buy_now', quantity, shipPromise: STOCK_PROMISE, euStock: true, batch: `${FC}:1`});
const preorderLine = (n = 2, quantity = 1) => line(n, {merchandiseId: CHOICE_IDS[FC].preorder, offer: 'preorder', quantity, shipPromise: MARCH, deliveryBy: '15 April 2027', batch: `${FC}:2`});
const motorLine = (n = 3) => line(n, {merchandiseId: CHOICE_IDS['OPENMOTOR-1604'].preorder, sku: 'OPENMOTOR-1604', handle: 'openmotor', title: 'OpenMotor', variantTitle: '1604', selectedOptions: [], shipPromise: MARCH, deliveryBy: '15 April 2027', batch: 'OPENMOTOR-1604:1'});

function cart(lines: ShopifyCartLine[]): ShopifyCart {
  return {id: 'cart-a', checkoutUrl: CHECKOUT, totalQuantity: lines.reduce((n, l) => n + l.quantity, 0), subtotal: {amount: '0.00', currencyCode: 'EUR'}, total: {amount: '0.00', currencyCode: 'EUR'}, country: 'BE', lines};
}

async function run(values: Record<string, string | string[]>, deps: Partial<ShopifyCartDependencies>): Promise<Response> {
  try {
    return await handleShopifyCartAction(request(values), ENV, {
      fetchCatalog: async () => live(),
      createCart: async () => { throw new Error('must not create'); },
      getCartId: () => 'cart-a',
      ...deps,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

describe('cart: an old cart with an in-stock board, and one currency', () => {
  it('EU: a Buy now line moves to the Pre-order variant of the same board, same quantity; other lines stay', () => {
    const catalog = live();
    assert.equal(sellsBuyNow(catalog), true);
    assert.deepEqual(buyNowToPreorder(cart([buyNowLine(1, 3), preorderLine(2), motorLine(3)]), catalog), [
      {id: buyNowLine(1).id, quantity: 3, merchandiseId: CHOICE_IDS[FC].preorder},
    ]);
  });
  it('outside the EU, or batch 1 gone: the same move (the region sells no in-stock boards)', () => {
    for (const catalog of [live({}, 'US'), live({[FC]: 200})]) {
      assert.deepEqual(buyNowToPreorder(cart([buyNowLine(1, 2)]), catalog), [{id: buyNowLine(1).id, quantity: 2, merchandiseId: CHOICE_IDS[FC].preorder}]);
    }
    assert.equal(sellsBuyNow(live({}, 'US')), false);
  });
  it('a cart of pre-orders only moves nothing', () => {
    assert.deepEqual(buyNowToPreorder(cart([preorderLine(2), motorLine(3)]), live()), []);
  });
  it('names a line Shopify did not price in the destination currency', () => {
    const usd = (l: ShopifyCartLine) => ({...l, total: {amount: '1.00', currencyCode: 'USD'}});
    const lines = [usd(preorderLine(2)), motorLine(3)];
    assert.deepEqual(cartCurrencyMisses(cart(lines), 'USD').map((l) => l.id), [motorLine(3).id]);
    assert.deepEqual(cartCurrencyMisses(cart(lines.map(usd)), 'USD'), []);
  });
});

describe('cart: the pre-order lane takes pre-orders only', () => {
  it('an add of a board puts its Pre-order variant in the cart, never its Buy now variant', async () => {
    const created: CartLineInput[][] = [];
    const deps = {getCartId: () => undefined, createCart: async (lines: CartLineInput[]) => { created.push(lines); return cart([]); }};
    await run({sku: FC, qty: '1'}, deps);
    await run({sku: FC, qty: '1', offer: 'preorder'}, deps);
    for (const lines of created) {
      assert.equal(lines[0].merchandiseId, CHOICE_IDS[FC].preorder);
      assert.deepEqual(lines[0].attributes, [
        {key: 'Preorder', value: MARCH},
        {key: 'Delivery by', value: '15 April 2027'},
        {key: '_batch', value: `${FC}:2`},
      ]);
    }
  });

  it('refuses a Buy now variant at add: offer=buy_now, or a board whose only open offer is Buy now', async () => {
    assert.equal((await run({sku: FC, qty: '1', offer: 'buy_now'}, {getCartId: () => undefined})).status, 400);
    assert.equal((await run({sku: FC, qty: '1', offer: 'cheap'}, {})).status, 400);
    const noPreorder = live();
    const board = bySku(noPreorder, FC)!.variant;
    delete board.preorder_offer;
    const refused = await run({sku: FC, qty: '1'}, {fetchCatalog: async () => noPreorder, getCartId: () => undefined});
    assert.equal(refused.status, 409);
    assert.match(await refused.text(), /product page/);
  });

  it('a product with one offer adds that offer; pre-orders are not capped by batch 1', async () => {
    const created: CartLineInput[][] = [];
    await run({sku: 'OPENMOTOR-1604', qty: '4', offer: 'preorder'}, {getCartId: () => undefined, createCart: async (lines) => { created.push(lines); return cart([]); }});
    assert.equal(created[0][0].merchandiseId, CHOICE_IDS['OPENMOTOR-1604'].preorder);
    await run({sku: FC, qty: '3'}, {fetchCatalog: async () => live({[FC]: 198}), getCartId: () => undefined, createCart: async (lines) => { created.push(lines); return cart([]); }});
    assert.equal(created[1][0].merchandiseId, CHOICE_IDS[FC].preorder);
  });

  it('flag off: an add still buys the one existing variant, as batch 1 stock', async () => {
    let created: CartLineInput[] = [];
    await run({sku: FC, qty: '1'}, {fetchCatalog: async () => live({}, 'EU', false), getCartId: () => undefined, createCart: async (lines) => { created = lines; return cart([]); }});
    assert.equal(created[0].merchandiseId, CHOICE_IDS[FC].preorder);
    assert.equal(created[0].attributes?.[0].key, 'Shipping');
  });

  it('the server still refuses a checkout that somehow holds a Buy now board and a March item', async () => {
    const info = (c: ShopifyCart) => cartLineInfo(c, live());
    const conflict = (lines: ShopifyCartLine[]) => { const c = cart(lines); return batchChoiceConflict(c, info(c)); };
    assert.equal(conflict([buyNowLine()]), false);
    assert.equal(conflict([preorderLine(), motorLine()]), false);
    assert.equal(conflict([buyNowLine(), motorLine()]), true);
    assert.equal(conflict([buyNowLine(), preorderLine()]), true);
    for (const seen of [{}, {datesSeen: '1'}] as Array<Record<string, string>>) {
      const response = await run({intent: 'checkout', ...seen}, {
        getCart: async () => cart([buyNowLine(), motorLine()]),
        updateCartLines: async () => { throw new Error('must not write'); },
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('Location'), `/cart?check=${CART_CHECK.batchChoice}`);
    }
    const ok = cart([preorderLine(1, 2), motorLine()]);
    const checkout = await run({intent: 'checkout', datesSeen: '1'}, {getCart: async () => ok, updateCartLines: async () => ok});
    assert.equal(checkout.headers.get('Location'), CHECKOUT);
  });

  it('marks early bird lines, so the summary note shows only with one', () => {
    const c = cart([preorderLine(), motorLine(), line(6, {merchandiseId: CHOICE_IDS[FC30].preorder, sku: FC30, variantTitle: '30×30', shipPromise: MARCH})]);
    assert.deepEqual(Object.values(cartLineInfo(c, live())).map((i) => i.early), [true, true, false]);
  });
});

describe('buy now lane: an express checkout of in-stock boards, never the cart', () => {
  const ESC = 'OPENESC-2020';
  const EXPRESS_CHECKOUT = 'https://checkout.opendrone.be/checkouts/cn/express';
  const express = (values: Record<string, string>, deps: Partial<ShopifyCartDependencies> = {}) => {
    const made: CartLineInput[][] = [];
    const stored: string[] = [];
    const response = run({intent: EXPRESS_INTENT, return: '/products/openfc-lite?Model=20%C3%9720', ...values}, {
      getCartId: () => 'cart-a',
      setCartId: (id) => { stored.push(id); },
      getCart: async () => { throw new Error('the session cart is never read'); },
      addCartLines: async () => { throw new Error('the session cart is never written'); },
      createCart: async (lines) => {
        made.push(lines);
        return {...cart(lines.map((l, i) => line(10 + i, {merchandiseId: l.merchandiseId, quantity: l.quantity}))), id: 'cart-express', checkoutUrl: EXPRESS_CHECKOUT};
      },
      ...deps,
    });
    return {response, made, stored};
  };

  it('a stack: both Buy now variants in one checkout of their own, tagged batch 1', async () => {
    const {response, made, stored} = express({lines: `${FC}:2,${ESC}:2`});
    assert.equal((await response).headers.get('Location'), EXPRESS_CHECKOUT);
    assert.deepEqual(made[0].map((l) => [l.merchandiseId, l.quantity]), [[CHOICE_IDS[FC].buyNow, 2], [CHOICE_IDS[ESC].buyNow, 2]]);
    assert.deepEqual(made[0].map((l) => l.attributes?.find((a) => a.key === '_batch')?.value), [`${FC}:1`, `${ESC}:1`]);
    // Not the session cart: nothing else can join this order.
    assert.deepEqual(stored, []);
  });

  it('a single board bought now', async () => {
    const {response, made} = express({sku: FC, qty: '1'});
    assert.equal((await response).headers.get('Location'), EXPRESS_CHECKOUT);
    assert.deepEqual(made[0].map((l) => l.merchandiseId), [CHOICE_IDS[FC].buyNow]);
  });

  it('stock ran out between page load and purchase: back to the page with a message, nothing sold', async () => {
    // 2 left of the 3-inch FC, 3 asked.
    const short = express({lines: `${FC}:3,${ESC}:3`}, {fetchCatalog: async () => live({[FC]: 198})});
    assert.equal((await short.response).headers.get('Location'), `/products/openfc-lite?Model=20%C3%9720&${EXPRESS_PARAM}=${EXPRESS_REFUSED.stock}`);
    assert.deepEqual(short.made, []);
    // Batch 1 gone: the board is pre-order only, so the express offer is refused.
    const gone = express({sku: FC, qty: '1'}, {fetchCatalog: async () => live({[FC]: 200})});
    assert.match((await gone.response).headers.get('Location') ?? '', /buy=sold-out$/);
    // Shopify's deny gate took the last units first: the checkout is never opened.
    const denied = express({sku: FC, qty: '2'}, {createCart: async (lines) => cart([line(9, {merchandiseId: lines[0].merchandiseId, quantity: 1})])});
    assert.match((await denied.response).headers.get('Location') ?? '', /buy=sold-out$/);
  });

  it('EU only: any other destination is refused before Shopify is asked', async () => {
    for (const country of ['US', 'GB', 'CH', 'CA', 'AU']) {
      const {response, made} = express({sku: FC, qty: '1', country}, {fetchCatalog: async () => live({}, 'US')});
      assert.match((await response).headers.get('Location') ?? '', /buy=eu-only$/, country);
      assert.deepEqual(made, []);
    }
    assert.deepEqual(expressLines(live({}, 'US'), [{sku: FC, quantity: 1}], 'US', false), {refused: EXPRESS_REFUSED.region});
  });

  it('only in-stock boards: a pre-order item cannot ride along', async () => {
    const {response, made} = express({lines: `${FC}:1,OPENMOTOR-1604:4`});
    assert.match((await response).headers.get('Location') ?? '', /buy=sold-out$/);
    assert.deepEqual(made, []);
  });

  describe('board page: the stack is an add-on to this board, unticked by default', () => {
    const builds = parseBuilds(JSON.parse(fs.readFileSync(new URL('../../content/builds.json', import.meta.url), 'utf8')));
    const stackFor = (catalog: Catalog) => {
      const build = resolveHeroBuilds(builds, catalog, true).find((b) => b.parts.some((part) => part.sku === FC));
      return build ? stackOffer(build) : null;
    };

    it('toggle off: one line, this board, straight to checkout', async () => {
      const lines = boardExpressLines(FC, stackFor(live()), false);
      assert.deepEqual(lines, [{sku: FC, quantity: 1}]);
      const {response, made} = express({lines: expressLinesField(lines, 2)});
      assert.equal((await response).headers.get('Location'), EXPRESS_CHECKOUT);
      assert.deepEqual(made[0].map((l) => [l.merchandiseId, l.quantity]), [[CHOICE_IDS[FC].buyNow, 2]]);
    });

    it('toggle on: two lines, this board and its partner, both batch 1', async () => {
      const lines = boardExpressLines(FC, stackFor(live()), true);
      assert.deepEqual(lines.map((l) => l.sku).sort(), [ESC, FC].sort());
      const {response, made} = express({lines: expressLinesField(lines, 1)});
      assert.equal((await response).headers.get('Location'), EXPRESS_CHECKOUT);
      assert.deepEqual(made[0].map((l) => l.merchandiseId).sort(), [CHOICE_IDS[FC].buyNow, CHOICE_IDS[ESC].buyNow].sort());
      assert.deepEqual(made[0].map((l) => l.attributes?.find((a) => a.key === '_batch')?.value).sort(), [`${ESC}:1`, `${FC}:1`].sort());
    });

    it('partner in stock at page load, sold out at purchase: back with a message, nothing created', async () => {
      const lines = boardExpressLines(FC, stackFor(live()), true);
      const {response, made} = express({lines: expressLinesField(lines, 1)}, {fetchCatalog: async () => live({[ESC]: 200})});
      assert.match((await response).headers.get('Location') ?? '', /buy=sold-out$/);
      assert.deepEqual(made, []);
    });

    it('one tick row, the partner board at the chosen lane price; pre-order adds both boards as pre-orders in one add', () => {
      const build = buildForPart(resolveHeroBuilds(builds, live(), true), FC, 'openfc-lite')!;
      assert.equal(partnerBoard(build, FC, 'buy_now')?.sku, ESC);
      const pre = partnerBoard(build, FC, 'preorder')!;
      assert.equal(pre.sku, ESC);
      assert.equal(pre.offer, 'preorder');
      assert.ok(pre.price! < partnerBoard(build, FC, 'buy_now')!.price!, 'the pre-order row shows the pre-order price');
      const url = new URL(buildAddonUrl(build, FC, [pre], 2), 'https://opendrone.be');
      assert.equal(url.searchParams.get('lines'), `${FC}:2,${ESC}:2`);
      assert.equal(url.searchParams.get('offer'), 'preorder');
      // The total is the sum of the two pre-order prices, times the quantity.
      assert.equal(buildAddonTotal(26.1, [pre], 2), Math.round((26.1 + pre.price!) * 2 * 100) / 100);
      assert.equal(fullBuildHref(build.size), `/?build=${build.size}#build`);
    });

    it('no tick row on a frame page, and no partner the region cannot buy', () => {
      const all = resolveHeroBuilds(builds, live(), true);
      const frame = buildForPart(all, 'OPENFRAME-3', 'openframe')!;
      assert.equal(partnerBoard(frame, 'OPENFRAME-3', 'preorder'), null);
      // US: no Buy now lane, so no stack; the pre-order partner stays.
      const us = buildForPart(resolveHeroBuilds(builds, live({}, 'US'), true), FC, 'openfc-lite')!;
      assert.equal(partnerBoard(us, FC, 'buy_now'), null);
      assert.equal(partnerBoard(us, FC, 'preorder')?.sku, ESC);
      // EU, ESC batch 1 gone: Buy now has no partner, pre-order still does.
      const gone = buildForPart(resolveHeroBuilds(builds, live({[ESC]: 200}), true), FC, 'openfc-lite')!;
      assert.equal(partnerBoard(gone, FC, 'buy_now'), null);
      assert.equal(partnerBoard(gone, FC, 'preorder')?.sku, ESC);
    });

    it('partner sold out: no stack add-on, and a ticked box still buys this board alone', () => {
      const stack = stackFor(live({[ESC]: 200}));
      assert.equal(stack, null);
      assert.deepEqual(boardExpressLines(FC, stack, true), [{sku: FC, quantity: 1}]);
    });
  });

  it('the return path stays on the site', async () => {
    const {response} = express({sku: FC, qty: '5', return: '//evil.example/x'}, {fetchCatalog: async () => live({[FC]: 198})});
    assert.equal((await response).headers.get('Location'), `/?${EXPRESS_PARAM}=${EXPRESS_REFUSED.stock}`);
  });
});

describe('one page for every region: outside the EU the Buy now lane is simply absent', () => {
  const builds = parseBuilds(JSON.parse(fs.readFileSync(new URL('../../content/builds.json', import.meta.url), 'utf8')));
  // US, GB/CH (NEAR), CA/AU (INT): the regions the catalog resolves them to.
  for (const region of ['US', 'NEAR', 'INT'] as const) {
    it(`${region}: every board is pre-order only, at its pre-order price, with no stack offer`, () => {
      const catalog = live({}, region);
      for (const sku of [FC, FC30, 'OPENESC-2020', 'OPENESC-3030']) {
        const board = bySku(catalog, sku)!.variant;
        assert.notEqual(board.offer, 'buy_now', `${region} ${sku}`);
        assert.equal(board.preorder_offer, undefined);
      }
      assert.deepEqual(resolveHeroBuilds(builds, catalog, true).map((b) => stackOffer(b)), [null, null]);
    });
  }
  it('EU: both sizes offer the stack at the sum of the two Buy now prices', () => {
    const stacks = resolveHeroBuilds(builds, live(), true).map((b) => stackOffer(b));
    assert.deepEqual(stacks.map((s) => s && [s.size, s.price]).sort(), [['3', 78], ['5', 98]]);
  });
  it('EU, one board of a size sold out: no stack for that size', () => {
    const stacks = resolveHeroBuilds(builds, live({[FC]: 200}), true).map((b) => stackOffer(b));
    assert.deepEqual(stacks.filter(Boolean).map((s) => s!.size), ['5']);
  });
});

describe('the saving is stated only where there is one', () => {
  it('20x20 saves the gap, 30x30 saves nothing', () => {
    const catalog = live();
    const saving = (sku: string) => { const v = bySku(catalog, sku)!.variant; return offerSaving(v.price, v.preorder_offer!.price); };
    assert.equal(saving(FC), 2.9);
    assert.equal(saving('OPENESC-2020'), 4.9);
    assert.equal(saving(FC30), null);
    assert.equal(saving('OPENESC-3030'), null);
  });
});

describe('home build block: two modes, each total is the sum of its rows', () => {
  const builds = parseBuilds(JSON.parse(fs.readFileSync(new URL('../../content/builds.json', import.meta.url), 'utf8')));
  const sum = (parts: Array<{price: number | null; quantity: number}>) => Math.round(parts.reduce((n, p) => n + Math.round((p.price ?? 0) * 100) * p.quantity, 0)) / 100;

  it('buy now is the stack at retail; pre-order is the full build at pre-order prices, added as pre-orders', () => {
    const build = resolveHeroBuilds(builds, live(), true).find((b) => b.id === '3-inch')!;
    assert.equal(build.choice, true);
    const modes = buildModes(build);
    assert.deepEqual(modes.buy_now!.parts.map((p) => [p.sku, p.price]), [[FC, 29], ['OPENESC-2020', 49]].sort((a, b) => modes.buy_now!.parts.findIndex((p) => p.sku === a[0]) - modes.buy_now!.parts.findIndex((p) => p.sku === b[0])));
    const boards = modes.preorder.parts.filter((p) => p.role === 'flight-controller' || p.role === 'esc');
    assert.deepEqual(boards.map((p) => p.price).sort(), [26.1, 44.1]);
    assert.ok(boards.every((p) => p.shipPromise === 'ships by 31 March 2027'));
    for (const mode of ['buy_now', 'preorder'] as const) {
      const shown = modes[mode]!;
      const all = new Set(shown.parts.filter((p) => p.price !== null).map((p) => p.sku));
      const selection = heroBuildSelection({...shown, parts: shown.parts.filter((p) => all.has(p.sku))}, all, () => true);
      assert.equal(selection.total, sum(selection.parts), mode);
    }
    assert.match(modeAddUrl('/api/shopify/cart?lines=A:1', 'preorder'), /&offer=preorder$/);
    assert.equal(modeAddUrl('/api/shopify/cart?lines=A:1', 'buy_now'), '/api/shopify/cart?lines=A:1');
  });

  it('no stack in stock for this buyer: pre-order only; flag off: no choice block', () => {
    assert.equal(buildModes(resolveHeroBuilds(builds, live({}, 'US'), true)[0]).buy_now, null);
    assert.equal(buildModes(resolveHeroBuilds(builds, live({[FC]: 200, [FC30]: 200}), true)[0]).buy_now, null);
    assert.equal(resolveHeroBuilds(builds, live({}, 'EU', false))[0].choice, undefined);
  });
});

describe('rollout order is held by the repository', () => {
  const toml = (name: string) => fs.readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
  const flag = (name: string) => toml(name).match(/^BATCH_CHOICE = "([^"]*)"$/m)?.[1];

  it('every environment names the flag, and it is "0" or "1"', () => {
    for (const name of ['wrangler.toml', 'wrangler.production.toml', 'wrangler.shoptest.toml']) {
      assert.ok(['0', '1'].includes(flag(name) ?? ''), `${name} must set BATCH_CHOICE to "0" or "1"`);
    }
  });

  it('production turns the choice on only with choiceFrom set, so pre-order lines count as March units', () => {
    const config = parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')));
    if (flag('wrangler.production.toml') === '1') assert.ok(config.choiceFrom, 'set choiceFrom in content/preorders.json in the PR that sets BATCH_CHOICE = "1"');
    else assert.equal(config.choiceFrom, undefined, 'choiceFrom is set in the same PR as BATCH_CHOICE = "1", not before');
  });
});
