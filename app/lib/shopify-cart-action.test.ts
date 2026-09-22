import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {PRODUCT_CONTENT} from './product-content.ts';
import {campaignState} from './preorder-campaign.ts';
import {
  handleShopifyCartAction,
  handleShopifyCartLoader,
  loadSessionCart,
  cartLineInfo,
  paidBatchLeft,
  paidBatchMessage,
  lineLimitMessage,
  splitPlan,
  variantLink,
  type ShopifyCartDependencies,
} from './shopify-cart-action.ts';
import type {ShopifyCart, ShopifyCartLine} from './shopify-storefront.ts';

function request(values: Record<string, string | string[]>): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
  }
  return new Request('https://opendrone.be/api/shopify/cart', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be'},
    body,
  });
}

const VARIANT_ID = 'gid://shopify/ProductVariant/server-authoritative';
const CHECKOUT = 'https://checkout.opendrone.be/checkouts/cn/ok';

const CATALOG: Catalog = {
  schema: 1,
  generated_at: '2026-09-20T00:00:00Z',
  max_age: 0,
  currency: 'EUR',
  prices_include_vat: true,
  shop_url: 'https://store.myshopify.com',
  cart_url: 'https://store.myshopify.com/cart',
  add_url: '/api/shopify/cart',
  add_method: 'POST',
  products: [{
    handle: 'openrx', title: 'OpenRX', family: null, description: null,
    url: '/products/openrx', images: [], rating: null,
    variants: [{
      sku: 'OPENRX-LITE', title: 'Lite', model: 'Lite', options: {Model: 'Lite'},
      price: 999.99, compare_price: null, currency: 'EUR',
      availability: 'preorder', ship_promise: 'preview promise', image: null,
      url: '/products/openrx', cart_add_url: '/api/shopify/cart',
      merchandise_id: VARIANT_ID,
    }],
  }],
};

const ENABLED_ENV = {
  SHOPIFY_CHECKOUT_WRITE_ENABLED: '1',
  PUBLIC_COMING_SOON: '0',
} as const;

function line(overrides: Partial<ShopifyCartLine> = {}): ShopifyCartLine {
  return {
    id: 'gid://shopify/CartLine/1?cart=a',
    merchandiseId: VARIANT_ID,
    quantity: 1,
    title: 'OpenRX',
    variantTitle: 'Lite',
    handle: 'openrx',
    sku: 'OPENRX-LITE',
    image: null,
    selectedOptions: [],
    shipPromise: 'preview promise',
    total: {amount: '999.99', currencyCode: 'EUR'},
    ...overrides,
  };
}

function cart(lines: ShopifyCartLine[] = [], id = 'gid://shopify/Cart/a?key=secret'): ShopifyCart {
  return {
    id,
    checkoutUrl: CHECKOUT,
    totalQuantity: lines.reduce((n, l) => n + l.quantity, 0),
    subtotal: {amount: '0.00', currencyCode: 'EUR'},
    total: {amount: '0.00', currencyCode: 'EUR'},
    lines,
  };
}

const MUST_NOT: Pick<ShopifyCartDependencies, 'createCart'> = {
  createCart: async () => { throw new Error('must not create'); },
};

async function thrownResponse(promise: Promise<unknown> | (() => unknown)): Promise<Response> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    assert.ok(error instanceof Response);
    return error;
  }
  throw new Error('expected a thrown Response');
}

describe('Shopify cart action: gates', () => {
  it('rejects non-POST methods before any backend call', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      new Request('https://opendrone.be/api/shopify/cart', {method: 'PUT'}),
      ENABLED_ENV,
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, ...MUST_NOT},
    ));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
    assert.equal(fetched, false);
  });

  it('is disabled until the write gate opens', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}), {},
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, ...MUST_NOT},
    ));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(fetched, false);
  });

  it('keeps checkout globally closed by default before catalog access', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}),
      {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1'},
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, ...MUST_NOT},
    ));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Checkout is closed.');
    assert.equal(fetched, false);
  });

  it('rejects a cross-origin POST before backend access', async () => {
    let fetched = false;
    const bad = request({sku: 'OPENRX-LITE', qty: '1'});
    bad.headers.set('Origin', 'https://attacker.test');
    const response = await thrownResponse(handleShopifyCartAction(
      bad, ENABLED_ENV,
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, ...MUST_NOT},
    ));
    assert.equal(response.status, 403);
    assert.equal(fetched, false);
  });

  it('rejects malformed, oversized and non-form bodies before fetching the catalog', async () => {
    let fetched = false;
    const deps = {fetchCatalog: async () => { fetched = true; return CATALOG; }, ...MUST_NOT};
    assert.equal((await thrownResponse(handleShopifyCartAction(request({sku: 'OPENRX-LITE', qty: '-1'}), ENABLED_ENV, deps))).status, 400);
    const oversized = request({sku: 'OPENRX-LITE', qty: '1'});
    oversized.headers.set('Content-Length', '8193');
    assert.equal((await thrownResponse(handleShopifyCartAction(oversized, ENABLED_ENV, deps))).status, 413);
    const json = new Request('https://opendrone.be/api/shopify/cart', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Origin: 'https://opendrone.be'},
      body: '{"sku":"OPENRX-LITE"}',
    });
    assert.equal((await thrownResponse(handleShopifyCartAction(json, ENABLED_ENV, deps))).status, 400);
    assert.equal((await thrownResponse(handleShopifyCartAction(request({sku: 'OPENRX-LITE', qty: '1', mode: 'set'}), ENABLED_ENV, deps))).status, 400);
    assert.equal((await thrownResponse(handleShopifyCartAction(request({intent: 'nope'}), ENABLED_ENV, deps))).status, 400);
    assert.equal(fetched, false);
  });
});

describe('Shopify cart action: add', () => {
  it('creates a cart from request-time catalog identity, ignores a client price and shows the cart', async () => {
    let received: unknown;
    let stored = '';
    const response = await handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '2', price: '0.01', merchandiseId: 'attacker'}),
      ENABLED_ENV,
      {
        fetchCatalog: async () => CATALOG,
        createCart: async (lines) => { received = lines; return cart(); },
        setCartId: (id) => { stored = id; },
      },
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), '/cart');
    assert.equal(stored, 'gid://shopify/Cart/a?key=secret');
    assert.deepEqual(received, [{
      merchandiseId: VARIANT_ID,
      quantity: 2,
      attributes: [{key: 'Preorder', value: 'preview promise'}],
    }]);
  });

  it('adds several products in one go to the existing session cart', async () => {
    const two: Catalog = {
      ...CATALOG,
      products: [
        CATALOG.products[0],
        {
          ...CATALOG.products[0],
          handle: 'openesc',
          variants: [{...CATALOG.products[0].variants[0], sku: 'OPENESC-2020', availability: 'in_stock', ship_promise: null, merchandise_id: 'gid://shopify/ProductVariant/esc'}],
        },
      ],
    };
    let added: unknown;
    const response = await handleShopifyCartAction(
      request({lines: 'OPENRX-LITE:1,OPENESC-2020:2'}), ENABLED_ENV, {
        fetchCatalog: async () => two,
        getCartId: () => 'cart-a',
        getCart: async () => cart([line()], 'cart-a'),
        addCartLines: async (_id, lines) => { added = lines; return cart([], 'cart-a'); },
        ...MUST_NOT,
      },
    );
    assert.equal(response.headers.get('Location'), '/cart');
    assert.deepEqual(added, [
      {merchandiseId: VARIANT_ID, quantity: 1, attributes: [{key: 'Preorder', value: 'preview promise'}]},
      {merchandiseId: 'gid://shopify/ProductVariant/esc', quantity: 2},
    ]);
  });

  it('enforces the cumulative per-SKU quantity limit', async () => {
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '2'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'cart-b',
        getCart: async () => cart([line({quantity: 30}), line({id: 'gid://shopify/CartLine/2', quantity: 19})], 'cart-b'),
        addCartLines: async () => { throw new Error('must not add'); },
        ...MUST_NOT,
      },
    ));
    assert.equal(response.status, 400);
    assert.equal(
      await response.text(),
      'One order holds at most 50 units of each item. Your cart already has 49, so you can add 1 more.',
    );
  });

  it('states the per-order limit when the cart already holds 50', () => {
    assert.match(lineLimitMessage(50), /already has 50\. Check out this order first/);
    assert.match(lineLimitMessage(0), /you can add 50 more/);
  });

  it('starts a new cart when the session cart has expired', async () => {
    let unset = false;
    let created = false;
    const response = await handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'expired', getCart: async () => null,
        unsetCartId: () => { unset = true; },
        addCartLines: async () => { throw new Error('must not add'); },
        createCart: async () => { created = true; return cart(); },
      },
    );
    assert.equal(response.headers.get('Location'), '/cart');
    assert.equal(unset, true);
    assert.equal(created, true);
  });

  it('refuses an unknown SKU, a lifecycle-locked product and a preorder without a ship promise', async () => {
    assert.equal((await thrownResponse(handleShopifyCartAction(
      request({sku: 'UNKNOWN-SKU', qty: '1'}), ENABLED_ENV, {fetchCatalog: async () => CATALOG, ...MUST_NOT},
    ))).status, 409);

    const locked: Catalog = {
      ...CATALOG,
      products: [{...CATALOG.products[0], handle: 'openlink', variants: [{...CATALOG.products[0].variants[0], sku: 'LOCKED-SKU'}]}],
    };
    PRODUCT_CONTENT.openlink = {status: 'development'} as (typeof PRODUCT_CONTENT)[string];
    try {
      assert.equal((await thrownResponse(handleShopifyCartAction(
        request({sku: 'LOCKED-SKU', qty: '1'}), ENABLED_ENV, {fetchCatalog: async () => locked, ...MUST_NOT},
      ))).status, 409);
    } finally {
      delete PRODUCT_CONTENT.openlink;
    }

    const noPromise: Catalog = {
      ...CATALOG,
      products: [{...CATALOG.products[0], variants: [{...CATALOG.products[0].variants[0], ship_promise: null}]}],
    };
    assert.equal((await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}), ENABLED_ENV, {fetchCatalog: async () => noPromise, ...MUST_NOT},
    ))).status, 409);
  });

  it('turns an upstream failure into a safe 503', async () => {
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}), ENABLED_ENV,
      {fetchCatalog: async () => { throw new Error('upstream secret detail'); }, ...MUST_NOT},
    ));
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'Checkout temporarily unavailable.');
    assert.equal(response.headers.get('Retry-After'), '60');
  });
});

describe('Shopify cart action: background add', () => {
  it('returns the cart summary instead of the /cart redirect when asked', async () => {
    const response = await handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1', response: 'summary'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        createCart: async () => cart([line()]),
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {totalQuantity: number; lines: Array<{sku: string; shipPromise: string}>};
    assert.equal(body.totalQuantity, 1);
    assert.deepEqual([body.lines[0].sku, body.lines[0].shipPromise], ['OPENRX-LITE', 'preview promise']);
    // The drawer shows the line total and the cart subtotal.
    const priced = body as unknown as {subtotal: {amount: string}; lines: Array<{total: {amount: string}}>};
    assert.equal(priced.subtotal.amount, '0.00');
    assert.equal(priced.lines[0].total.amount, '999.99');
  });
});

describe('Shopify cart action: update, remove, checkout', () => {
  it('sets one line quantity and removes lines, then shows the cart', async () => {
    let updated: unknown;
    let removed: unknown;
    const deps: ShopifyCartDependencies = {
      fetchCatalog: async () => CATALOG,
      getCartId: () => 'cart-a',
      getCart: async () => cart([line()], 'cart-a'),
      updateCartLines: async (_id, lines) => { updated = lines; return cart(); },
      removeCartLines: async (_id, ids) => { removed = ids; return cart(); },
      ...MUST_NOT,
    };
    const up = await handleShopifyCartAction(request({intent: 'update', lineId: 'gid://shopify/CartLine/1?cart=a', quantity: '3'}), ENABLED_ENV, deps);
    assert.equal(up.headers.get('Location'), '/cart');
    assert.deepEqual(updated, [{id: 'gid://shopify/CartLine/1?cart=a', quantity: 3}]);
    await handleShopifyCartAction(request({intent: 'remove', lineId: 'gid://shopify/CartLine/1?cart=a'}), ENABLED_ENV, deps);
    assert.deepEqual(removed, ['gid://shopify/CartLine/1?cart=a']);
  });

  it('rejects a forged line id, a bad quantity and a missing cart', async () => {
    const deps: ShopifyCartDependencies = {fetchCatalog: async () => CATALOG, getCartId: () => 'cart-a', ...MUST_NOT};
    assert.equal((await thrownResponse(handleShopifyCartAction(request({intent: 'remove', lineId: 'https://attacker.test'}), ENABLED_ENV, deps))).status, 400);
    assert.equal((await thrownResponse(handleShopifyCartAction(request({intent: 'update', lineId: 'gid://shopify/CartLine/1', quantity: '51'}), ENABLED_ENV, deps))).status, 400);
    assert.equal((await thrownResponse(handleShopifyCartAction(request({intent: 'update', lineId: 'gid://shopify/CartLine/1', quantity: '1'}), ENABLED_ENV, {...deps, getCartId: () => undefined}))).status, 409);
  });

  it('hands a current cart straight to Shopify checkout', async () => {
    const response = await handleShopifyCartAction(request({intent: 'checkout'}), ENABLED_ENV, {
      fetchCatalog: async () => CATALOG,
      getCartId: () => 'cart-a',
      getCart: async () => cart([line()], 'cart-a'),
      updateCartLines: async () => { throw new Error('must not update'); },
      ...MUST_NOT,
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), CHECKOUT);
  });

  it('refreshes a preorder line whose ship promise moved, then shows the cart before payment', async () => {
    let updated: unknown;
    const response = await handleShopifyCartAction(request({intent: 'checkout'}), ENABLED_ENV, {
      fetchCatalog: async () => CATALOG,
      getCartId: () => 'cart-a',
      getCart: async () => cart([line({shipPromise: 'ships late October 2026', quantity: 2})], 'cart-a'),
      updateCartLines: async (_id, lines) => { updated = lines; return {...cart([], 'cart-a'), checkoutUrl: `${CHECKOUT}?v=2`}; },
      ...MUST_NOT,
    });
    assert.equal(response.headers.get('Location'), '/cart?check=ship-date');
    assert.deepEqual(updated, [{
      id: 'gid://shopify/CartLine/1?cart=a',
      quantity: 2,
      attributes: [{key: 'Preorder', value: 'preview promise'}],
    }]);
  });

  it('returns the cart summary for a background quantity change', async () => {
    const response = await handleShopifyCartAction(
      request({intent: 'update', lineId: 'gid://shopify/CartLine/1?cart=a', quantity: '2', response: 'summary'}),
      ENABLED_ENV,
      {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'cart-a',
        getCart: async () => cart([line()], 'cart-a'),
        updateCartLines: async () => cart([line({quantity: 2})], 'cart-a'),
        ...MUST_NOT,
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {totalQuantity: number};
    assert.equal(body.totalQuantity, 2);
  });

  it('blocks checkout when a line is no longer sold', async () => {
    const closed: Catalog = {
      ...CATALOG,
      products: [{...CATALOG.products[0], variants: [{...CATALOG.products[0].variants[0], availability: 'sold_out'}]}],
    };
    const response = await thrownResponse(handleShopifyCartAction(request({intent: 'checkout'}), ENABLED_ENV, {
      fetchCatalog: async () => closed,
      getCartId: () => 'cart-a',
      getCart: async () => cart([line()], 'cart-a'),
      ...MUST_NOT,
    }));
    assert.equal(response.status, 409);
  });
});

const PAID_ID = 'gid://shopify/ProductVariant/fc';
const PAID_PROMISE = 'ships late October 2026';
const BATCHES = [{units: 250, paid: true, ships: PAID_PROMISE}, {units: 250}];
const PENDING = 'ships about 10 weeks after its target is reached';

/** A catalog selling OPENFC-LITE-2020 from its paid batch after `ordered` paid units. */
function paidCatalog(ordered: number): Catalog {
  const campaign = campaignState(BATCHES, ordered, PENDING, [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}], 29);
  return {
    ...CATALOG,
    products: [
      ...CATALOG.products,
      {
        handle: 'openfc-lite', title: 'OpenFC Lite', family: null, description: null,
        url: '/products/openfc-lite', images: [], rating: null,
        variants: [{
          sku: 'OPENFC-LITE-2020', title: '20×20', model: '20×20', options: {Model: '20×20'},
          price: campaign.price ?? 29, compare_price: 29, currency: 'EUR',
          availability: 'preorder', ship_promise: campaign.shipPromise, image: null,
          url: '/products/openfc-lite', cart_add_url: '/api/shopify/cart',
          merchandise_id: PAID_ID, campaign,
        }],
      },
    ],
  };
}

function fcLine(overrides: Partial<ShopifyCartLine> = {}): ShopifyCartLine {
  return line({
    id: 'gid://shopify/CartLine/fc?cart=a', merchandiseId: PAID_ID, handle: 'openfc-lite',
    sku: 'OPENFC-LITE-2020', title: 'OpenFC Lite', variantTitle: '20×20', shipPromise: PAID_PROMISE,
    ...overrides,
  });
}

describe('Shopify cart action: paid batch limit', () => {
  it('knows the units left in the paid batch, and nothing for a funding target', () => {
    assert.equal(paidBatchLeft(paidCatalog(240).products[1].variants[0]), 10);
    assert.equal(paidBatchLeft(paidCatalog(250).products[1].variants[0]), null);
    assert.equal(paidBatchLeft(CATALOG.products[0].variants[0]), null);
    assert.match(paidBatchMessage(10, PAID_PROMISE), /Only 10 units are left in the paid batch \(ships late October 2026\)/);
    assert.match(paidBatchMessage(1, null), /^Only 1 unit is left in the paid batch\. /);
    assert.match(paidBatchMessage(10, null, 4), /Your cart already has 4\.$/);
  });

  it('refuses an add past the units left, counting the cart and the add together', async () => {
    const response = await thrownResponse(handleShopifyCartAction(
      request({lines: 'OPENFC-LITE-2020:4,OPENFC-LITE-2020:3'}), ENABLED_ENV, {
        fetchCatalog: async () => paidCatalog(240),
        getCartId: () => 'cart-a',
        getCart: async () => cart([fcLine({quantity: 4})], 'cart-a'),
        addCartLines: async () => { throw new Error('must not add'); },
        ...MUST_NOT,
      },
    ));
    assert.equal(response.status, 409);
    assert.match(await response.text(), /Only 10 units are left in the paid batch/);
  });

  it('refuses a new cart past the units left and accepts one within them', async () => {
    const over = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENFC-LITE-2020', qty: '11'}), ENABLED_ENV,
      {fetchCatalog: async () => paidCatalog(240), createCart: async () => { throw new Error('must not create'); }},
    ));
    assert.equal(over.status, 409);
    let created: unknown;
    await handleShopifyCartAction(
      request({sku: 'OPENFC-LITE-2020', qty: '10'}), ENABLED_ENV,
      {fetchCatalog: async () => paidCatalog(240), createCart: async (lines) => { created = lines; return cart(); }},
    );
    assert.deepEqual(created, [{merchandiseId: PAID_ID, quantity: 10, attributes: [{key: 'Preorder', value: PAID_PROMISE}]}]);
  });

  it('refuses a quantity update past the units left, but never blocks lowering it', async () => {
    const deps: ShopifyCartDependencies = {
      fetchCatalog: async () => paidCatalog(245),
      getCartId: () => 'cart-a',
      getCart: async () => cart([fcLine({quantity: 8})], 'cart-a'),
      updateCartLines: async () => cart([fcLine()], 'cart-a'),
      ...MUST_NOT,
    };
    const up = await thrownResponse(handleShopifyCartAction(
      request({intent: 'update', lineId: 'gid://shopify/CartLine/fc?cart=a', quantity: '9', response: 'summary'}), ENABLED_ENV, deps,
    ));
    assert.equal(up.status, 409);
    assert.match(await up.text(), /Only 5 units/);
    const down = await handleShopifyCartAction(
      request({intent: 'update', lineId: 'gid://shopify/CartLine/fc?cart=a', quantity: '7', response: 'summary'}),
      ENABLED_ENV,
      {...deps, fetchCatalog: async () => { throw new Error('must not read the catalog to lower a quantity'); }},
    );
    assert.equal(down.status, 200);
  });

  it('sends checkout back to the cart when a line is over the units left', async () => {
    const response = await handleShopifyCartAction(request({intent: 'checkout'}), ENABLED_ENV, {
      fetchCatalog: async () => paidCatalog(245),
      getCartId: () => 'cart-a',
      getCart: async () => cart([fcLine({quantity: 4}), fcLine({id: 'gid://shopify/CartLine/fc2', quantity: 2})], 'cart-a'),
      updateCartLines: async () => { throw new Error('must not update'); },
      ...MUST_NOT,
    });
    assert.equal(response.headers.get('Location'), '/cart?check=paid-batch');
  });

  it('hands a cart within the paid batch to checkout', async () => {
    const response = await handleShopifyCartAction(request({intent: 'checkout'}), ENABLED_ENV, {
      fetchCatalog: async () => paidCatalog(245),
      getCartId: () => 'cart-a',
      getCart: async () => cart([fcLine({quantity: 5})], 'cart-a'),
      ...MUST_NOT,
    });
    assert.equal(response.headers.get('Location'), CHECKOUT);
  });
});

describe('Shopify cart action: stale lines', () => {
  const deps: ShopifyCartDependencies = {
    fetchCatalog: async () => CATALOG,
    getCartId: () => 'cart-a',
    getCart: async () => cart([line()], 'cart-a'),
    updateCartLines: async () => { throw new Error('must not update'); },
    removeCartLines: async () => { throw new Error('must not remove'); },
    ...MUST_NOT,
  };
  const gone = 'gid://shopify/CartLine/gone';

  it('treats removing a line that is already gone as a no-op', async () => {
    const summary = await handleShopifyCartAction(request({intent: 'remove', lineId: gone, response: 'summary'}), ENABLED_ENV, deps);
    assert.equal(summary.status, 200);
    assert.equal(((await summary.json()) as {totalQuantity: number}).totalQuantity, 1);
    const plain = await handleShopifyCartAction(request({intent: 'remove', lineId: gone}), ENABLED_ENV, deps);
    assert.equal(plain.headers.get('Location'), '/cart');
  });

  it('answers 409, not 503, for an update to a line that is gone', async () => {
    const response = await thrownResponse(handleShopifyCartAction(
      request({intent: 'update', lineId: gone, quantity: '2', response: 'summary'}), ENABLED_ENV, deps,
    ));
    assert.equal(response.status, 409);
    assert.equal(await response.text(), 'This item is no longer in your cart.');
    const plain = await handleShopifyCartAction(request({intent: 'update', lineId: gone, quantity: '2'}), ENABLED_ENV, deps);
    assert.equal(plain.headers.get('Location'), '/cart');
  });

  it('removes only the lines still in the cart', async () => {
    let removed: unknown;
    await handleShopifyCartAction(
      request({intent: 'remove', lineId: [gone, 'gid://shopify/CartLine/1?cart=a']}), ENABLED_ENV,
      {...deps, removeCartLines: async (_id, ids) => { removed = ids; return cart(); }},
    );
    assert.deepEqual(removed, ['gid://shopify/CartLine/1?cart=a']);
  });

  it('forgets an expired session cart instead of failing', async () => {
    let unset = false;
    const response = await handleShopifyCartAction(
      request({intent: 'remove', lineId: gone, response: 'summary'}), ENABLED_ENV,
      {...deps, getCart: async () => null, unsetCartId: () => { unset = true; }},
    );
    assert.equal(response.status, 200);
    assert.equal(unset, true);
    assert.equal((await thrownResponse(handleShopifyCartAction(
      request({intent: 'update', lineId: gone, quantity: '2'}), ENABLED_ENV,
      {...deps, getCart: async () => null},
    ))).status, 409);
  });
});

describe('cart line info and split plan', () => {
  /** The paid FC catalog plus RX (target 250) and a motor (target 1000), both funding targets. */
  function mixedCatalog(): Catalog {
    const base = paidCatalog(240);
    const funding = (sku: string, id: string, batches: Array<{units: number}>, ordered: number) => {
      const campaign = campaignState(batches, ordered, PENDING, [], 20);
      return {
        ...CATALOG.products[0],
        handle: sku.toLowerCase(),
        variants: [{...CATALOG.products[0].variants[0], sku, merchandise_id: id, ship_promise: campaign.shipPromise, campaign}],
      };
    };
    return {
      ...base,
      products: [
        base.products[1],
        funding('OPENRX-LITE', 'gid://shopify/ProductVariant/rx', [{units: 250}, {units: 1000}], 200),
        funding('OPENMOTOR-2207', 'gid://shopify/ProductVariant/motor', [{units: 1000}, {units: 4000}], 12),
      ],
    };
  }
  const rxLine = line({id: 'gid://shopify/CartLine/rx', merchandiseId: 'gid://shopify/ProductVariant/rx', sku: 'OPENRX-LITE', shipPromise: PENDING});
  const motorLine = line({id: 'gid://shopify/CartLine/motor', merchandiseId: 'gid://shopify/ProductVariant/motor', sku: 'OPENMOTOR-2207', shipPromise: PENDING, quantity: 4});

  it('groups two funding targets apart even with the same promise text, and offers no split', () => {
    const c = cart([rxLine, motorLine]);
    const info = cartLineInfo(c, mixedCatalog());
    assert.equal(info[rxLine.id].group, 'target:OPENRX-LITE:1');
    assert.equal(info[motorLine.id].group, 'target:OPENMOTOR-2207:1');
    assert.deepEqual(info[motorLine.id].target, {units: 1000, ordered: 12});
    // Neither has a date: a second order ships nothing sooner, so no split.
    assert.equal(splitPlan(c, info), null);
  });

  it('keeps the paid stack and moves the funding targets to a second order', () => {
    const c = cart([fcLine({quantity: 3}), fcLine({id: 'gid://shopify/CartLine/fc2', quantity: 2}), rxLine, motorLine]);
    const info = cartLineInfo(c, mixedCatalog());
    assert.equal(info['gid://shopify/CartLine/fc?cart=a'].group, `date:${PAID_PROMISE}`);
    assert.equal(info['gid://shopify/CartLine/fc?cart=a'].maxQuantity, 8);
    assert.equal(info['gid://shopify/CartLine/fc2'].maxQuantity, 7);
    assert.equal(info[rxLine.id].maxQuantity, null);
    assert.deepEqual(splitPlan(c, info), {
      keep: ['gid://shopify/CartLine/fc?cart=a', 'gid://shopify/CartLine/fc2'],
      later: [rxLine.id, motorLine.id],
    });
  });

  it('offers no split when everything ships together, or without a catalog', () => {
    const one = cart([fcLine(), rxLine]);
    assert.equal(splitPlan(cart([rxLine]), cartLineInfo(cart([rxLine]), mixedCatalog())), null);
    const info = cartLineInfo(cart([rxLine, motorLine]), null);
    assert.equal(info[rxLine.id].group, info[motorLine.id].group);
    assert.equal(splitPlan(cart([rxLine, motorLine]), info), null);
    // Without the catalog a funding line cannot be told from a date: warn, but offer no split.
    assert.equal(splitPlan(one, cartLineInfo(one, null)), null);
  });
});

describe('variant link', () => {
  it('keeps the selected options and drops the default title', () => {
    assert.equal(
      variantLink('openfc-lite', [{name: 'Model', value: '30×30'}]),
      '/products/openfc-lite?Model=30%C3%9730',
    );
    assert.equal(variantLink('openrx', [{name: 'Title', value: 'Default Title'}]), '/products/openrx');
    assert.equal(variantLink('openmotor'), '/products/openmotor');
  });
});

describe('cart page and legacy cart link', () => {
  it('stay closed while checkout is closed, even with a session cart', async () => {
    let fetched = false;
    const getCart = async () => { fetched = true; return cart([line()]); };
    assert.equal((await thrownResponse(handleShopifyCartLoader(new Request('https://opendrone.be/api/shopify/cart'), {}))).status, 410);
    assert.equal((await thrownResponse(loadSessionCart({SHOPIFY_CHECKOUT_WRITE_ENABLED: '1'}, {getCartId: () => 'cart-a', getCart}))).status, 410);
    assert.equal(fetched, false);
  });

  it('send the legacy link to /cart and load the session cart once open', async () => {
    assert.equal((await handleShopifyCartLoader(new Request('https://opendrone.be/api/shopify/cart'), ENABLED_ENV)).headers.get('Location'), '/cart');
    const summary = await handleShopifyCartLoader(
      new Request('https://opendrone.be/api/shopify/cart?summary=1'), ENABLED_ENV,
      {getCartId: () => 'cart-a', getCart: async () => cart([line({quantity: 2})], 'cart-a')},
    );
    const body = (await summary.json()) as {totalQuantity: number; lines: unknown[]};
    assert.equal(body.totalQuantity, 2);
    assert.equal(JSON.stringify(body).includes('checkout'), false);
    const loaded = await loadSessionCart(ENABLED_ENV, {getCartId: () => 'cart-a', getCart: async () => cart([line()], 'cart-a')});
    assert.equal(loaded?.lines.length, 1);
    let unset = false;
    assert.equal(await loadSessionCart(ENABLED_ENV, {getCartId: () => 'gone', getCart: async () => null, unsetCartId: () => { unset = true; }}), null);
    assert.equal(unset, true);
  });
});
