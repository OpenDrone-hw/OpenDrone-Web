import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {bySku, offerSaving, preorderView, variantByMerchandise, type Catalog} from './catalog.ts';
import {buildModes, heroBuildSelection, modeAddUrl, resolveHeroBuilds} from './hero-build.ts';
import {parseBuilds} from './build-recommendations.ts';
import {applyCampaign, parseCampaignConfig, preorderChoiceLine, shipsOnlyWithPaid, type CampaignConfig} from './preorder-campaign.ts';
import {assignBatches, batchPromiseMismatch, batchTag, type PreorderOrder} from './preorder-fulfilment.ts';
import {
  CART_CHECK,
  KEEP_TOGETHER_INTENT,
  batchChoiceConflict,
  cartLineInfo,
  handleShopifyCartAction as actualCartAction,
  keepTogetherUpdates,
  splitPlan,
  type ShopifyCartDependencies,
} from './shopify-cart-action.ts';
import {fetchPaidUnitRuns} from './shopify-orders.ts';
import {batchChoiceOn, mapShopifyCatalog, type CartLineInput, type CartLineUpdate, type ShopifyCart, type ShopifyCartLine} from './shopify-storefront.ts';
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
const live = (ordered: Record<string, number> = {}, region: 'EU' | 'US' = 'EU', on = true): Catalog =>
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

describe('cart: adding either offer', () => {
  it('adds the Buy now variant by default and the Pre-order variant on offer=preorder', async () => {
    const created: CartLineInput[][] = [];
    const deps = {getCartId: () => undefined, createCart: async (lines: CartLineInput[]) => { created.push(lines); return cart([]); }};
    await run({sku: FC, qty: '1'}, deps);
    await run({sku: FC, qty: '1', offer: 'preorder'}, deps);
    assert.equal(created[0][0].merchandiseId, CHOICE_IDS[FC].buyNow);
    assert.deepEqual(created[0][0].attributes?.map((a) => a.key), ['Shipping', '_ship_promise', '_batch']);
    assert.equal(created[0][0].attributes?.at(-1)?.value, `${FC}:1`);
    assert.equal(created[1][0].merchandiseId, CHOICE_IDS[FC].preorder);
    assert.deepEqual(created[1][0].attributes, [
      {key: 'Preorder', value: MARCH},
      {key: 'Delivery by', value: '15 April 2027'},
      {key: '_batch', value: `${FC}:2`},
    ]);
  });

  it('offer=preorder on a product with one offer adds that offer; an unknown offer is refused', async () => {
    const created: CartLineInput[][] = [];
    await run({sku: 'OPENMOTOR-1604', qty: '4', offer: 'preorder'}, {getCartId: () => undefined, createCart: async (lines) => { created.push(lines); return cart([]); }});
    assert.equal(created[0][0].merchandiseId, CHOICE_IDS['OPENMOTOR-1604'].preorder);
    assert.equal((await run({sku: FC, qty: '1', offer: 'cheap'}, {})).status, 400);
  });

  it('caps Buy now at the units left and leaves Pre-order uncapped', async () => {
    const deps = {fetchCatalog: async () => live({[FC]: 198}), getCartId: () => undefined};
    const over = await run({sku: FC, qty: '3'}, deps);
    assert.equal(over.status, 409);
    let created: CartLineInput[] = [];
    await run({sku: FC, qty: '3', offer: 'preorder'}, {...deps, createCart: async (lines) => { created = lines; return cart([]); }});
    assert.equal(created[0].merchandiseId, CHOICE_IDS[FC].preorder);
  });

  it('flag off: an add still buys the one existing variant, as batch 1 stock', async () => {
    let created: CartLineInput[] = [];
    await run({sku: FC, qty: '1'}, {fetchCatalog: async () => live({}, 'EU', false), getCartId: () => undefined, createCart: async (lines) => { created = lines; return cart([]); }});
    assert.equal(created[0].merchandiseId, CHOICE_IDS[FC].preorder);
    assert.equal(created[0].attributes?.[0].key, 'Shipping');
  });
});

describe('cart: nobody pays retail for a board that ships in March', () => {
  const info = (c: ShopifyCart) => cartLineInfo(c, live());

  it('badges every line as ships now or pre-order with its month', () => {
    const c = cart([buyNowLine(), motorLine()]);
    assert.deepEqual(Object.values(info(c)).map((i) => [i.ships, i.month]), [['now', null], ['preorder', 'March 2027']]);
  });

  it('the rule: a Buy now board with any March line is a conflict', () => {
    const conflict = (lines: ShopifyCartLine[]) => { const c = cart(lines); return batchChoiceConflict(c, info(c)); };
    assert.equal(conflict([buyNowLine()]), false);
    assert.equal(conflict([buyNowLine(), line(4, {merchandiseId: CHOICE_IDS['OPENESC-2020'].buyNow, sku: 'OPENESC-2020', offer: 'buy_now', shipPromise: STOCK_PROMISE, euStock: true})]), false);
    assert.equal(conflict([preorderLine(), motorLine()]), false);
    assert.equal(conflict([buyNowLine(), motorLine()]), true);
    assert.equal(conflict([buyNowLine(), preorderLine()]), true);
  });

  it('checkout is refused while the conflict stands, even from a page that saw the dates', async () => {
    for (const seen of [{}, {datesSeen: '1'}] as Array<Record<string, string>>) {
      const response = await run({intent: 'checkout', ...seen}, {
        getCart: async () => cart([buyNowLine(), motorLine()]),
        updateCartLines: async () => { throw new Error('must not write'); },
      });
      assert.equal(response.status, 303);
      assert.equal(response.headers.get('Location'), `/cart?check=${CART_CHECK.batchChoice}`);
    }
  });

  it('"Keep everything in one order" moves each board to its pre-order variant and price', async () => {
    const before = cart([buyNowLine(1, 2), motorLine()]);
    assert.deepEqual(keepTogetherUpdates(before, live()), [{
      id: before.lines[0].id,
      quantity: 2,
      merchandiseId: CHOICE_IDS[FC].preorder,
      attributes: [{key: 'Preorder', value: MARCH}, {key: 'Delivery by', value: '15 April 2027'}, {key: '_batch', value: `${FC}:2`}],
    }]);
    let written: CartLineUpdate[] = [];
    const after = cart([preorderLine(1, 2), motorLine()]);
    const response = await run({intent: KEEP_TOGETHER_INTENT}, {
      getCart: async () => before,
      updateCartLines: async (_id, lines) => { written = lines; return after; },
    });
    assert.equal(response.headers.get('Location'), '/cart');
    assert.equal(written[0].merchandiseId, CHOICE_IDS[FC].preorder);
    // The cart that results checks out: every line is the March batch.
    assert.equal(batchChoiceConflict(after, info(after)), false);
    const checkout = await run({intent: 'checkout', datesSeen: '1'}, {getCart: async () => after, updateCartLines: async () => after});
    assert.equal(checkout.headers.get('Location'), CHECKOUT);
  });

  it('fails loudly when a board is still on its Buy now variant after the move', async () => {
    const stuck = cart([buyNowLine(), motorLine()]);
    const response = await run({intent: KEEP_TOGETHER_INTENT}, {getCart: async () => stuck, updateCartLines: async () => stuck});
    assert.equal(response.status, 503);
  });

  it('"Check out the in-stock items first" keeps the boards and sets the March lines aside', async () => {
    const c = cart([buyNowLine(), motorLine(), preorderLine()]);
    const plan = splitPlan(c, info(c))!;
    assert.deepEqual(plan.keep, [c.lines[0].id]);
    assert.deepEqual(plan.later, [c.lines[1].id, c.lines[2].id]);
    const kept = cart([buyNowLine()]);
    const checkout = await run({intent: 'checkout'}, {getCart: async () => kept, updateCartLines: async () => kept});
    assert.equal(checkout.headers.get('Location'), CHECKOUT);
  });

  it('cart edits: the conflict returns the moment a March line joins again, and a re-added board is Buy now again', async () => {
    // After "keep together" the buyer adds the board again from the product page (default offer).
    let added: CartLineInput[] = [];
    const moved = cart([preorderLine(1), motorLine()]);
    await run({sku: FC, qty: '1'}, {
      getCart: async () => (added.length ? cart([...moved.lines, buyNowLine(5)]) : moved),
      addCartLines: async (_id, lines) => { added = lines; return cart([...moved.lines, buyNowLine(5)]); },
    });
    assert.equal(added[0].merchandiseId, CHOICE_IDS[FC].buyNow);
    const edited = cart([...moved.lines, buyNowLine(5)]);
    const response = await run({intent: 'checkout', datesSeen: '1'}, {getCart: async () => edited, updateCartLines: async () => edited});
    assert.equal(response.headers.get('Location'), `/cart?check=${CART_CHECK.batchChoice}`);
    // Removing the March lines clears it.
    const boardsOnly = cart([buyNowLine(5)]);
    assert.equal(batchChoiceConflict(boardsOnly, info(boardsOnly)), false);
  });

  it('a quantity edit on a Buy now line stays inside the units left', async () => {
    const c = cart([buyNowLine(1, 1)]);
    const response = await run({intent: 'update', lineId: c.lines[0].id, quantity: '5'}, {
      fetchCatalog: async () => live({[FC]: 197}),
      getCart: async () => c,
      updateCartLines: async () => { throw new Error('must not write'); },
    });
    assert.equal(response.status, 409);
  });

  it('a Buy now line whose stock is gone cannot be checked out as stock', async () => {
    const c = cart([buyNowLine()]);
    const response = await run({intent: 'checkout'}, {fetchCatalog: async () => live({[FC]: 200}), getCart: async () => c});
    assert.equal(response.status, 409);
    // The cart can still move it to the pre-order.
    assert.equal(keepTogetherUpdates(c, live({[FC]: 200}))?.[0].merchandiseId, CHOICE_IDS[FC].preorder);
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
