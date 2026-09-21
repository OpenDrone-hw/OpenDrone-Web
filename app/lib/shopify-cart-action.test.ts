import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {PRODUCT_CONTENT} from './product-content.ts';
import {
  handleShopifyCartAction,
  handleShopifyCartLoader,
  loadSessionCart,
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

describe('Shopify cart action: update, remove, checkout', () => {
  it('sets one line quantity and removes lines, then shows the cart', async () => {
    let updated: unknown;
    let removed: unknown;
    const deps: ShopifyCartDependencies = {
      fetchCatalog: async () => CATALOG,
      getCartId: () => 'cart-a',
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

  it('refreshes a preorder line whose ship promise moved before checkout', async () => {
    let updated: unknown;
    const response = await handleShopifyCartAction(request({intent: 'checkout'}), ENABLED_ENV, {
      fetchCatalog: async () => CATALOG,
      getCartId: () => 'cart-a',
      getCart: async () => cart([line({shipPromise: 'ships late October 2026', quantity: 2})], 'cart-a'),
      updateCartLines: async (_id, lines) => { updated = lines; return {...cart([], 'cart-a'), checkoutUrl: `${CHECKOUT}?v=2`}; },
      ...MUST_NOT,
    });
    assert.equal(response.headers.get('Location'), `${CHECKOUT}?v=2`);
    assert.deepEqual(updated, [{
      id: 'gid://shopify/CartLine/1?cart=a',
      quantity: 2,
      attributes: [{key: 'Preorder', value: 'preview promise'}],
    }]);
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

describe('cart page and legacy cart link', () => {
  it('stay closed while checkout is closed, even with a session cart', async () => {
    let fetched = false;
    const getCart = async () => { fetched = true; return cart([line()]); };
    assert.equal((await thrownResponse(() => handleShopifyCartLoader({}))).status, 410);
    assert.equal((await thrownResponse(loadSessionCart({SHOPIFY_CHECKOUT_WRITE_ENABLED: '1'}, {getCartId: () => 'cart-a', getCart}))).status, 410);
    assert.equal(fetched, false);
  });

  it('send the legacy link to /cart and load the session cart once open', async () => {
    assert.equal(handleShopifyCartLoader(ENABLED_ENV).headers.get('Location'), '/cart');
    const loaded = await loadSessionCart(ENABLED_ENV, {getCartId: () => 'cart-a', getCart: async () => cart([line()], 'cart-a')});
    assert.equal(loaded?.lines.length, 1);
    let unset = false;
    assert.equal(await loadSessionCart(ENABLED_ENV, {getCartId: () => 'gone', getCart: async () => null, unsetCartId: () => { unset = true; }}), null);
    assert.equal(unset, true);
  });
});
