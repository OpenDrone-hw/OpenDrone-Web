import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {Catalog} from './catalog.ts';
import {PRODUCT_CONTENT} from './product-content.ts';
import {handleShopifyCartAction, handleShopifyCartLoader} from './shopify-cart-action.ts';

function request(values: Record<string, string>): Request {
  return new Request('https://opendrone.be/api/shopify/cart', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://opendrone.be'},
    body: new URLSearchParams(values),
  });
}

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
      merchandise_id: 'gid://shopify/ProductVariant/server-authoritative',
    }],
  }],
};

const ENABLED_ENV = {
  SHOPIFY_ADAPTER_PREVIEW: '1',
  SHOPIFY_CHECKOUT_WRITE_ENABLED: '1',
  SHOPIFY_SHIPPING_LATER_CONFIRMED: '1',
  PUBLIC_COMING_SOON: '0',
} as const;


async function thrownResponse(promise: Promise<Response>): Promise<Response> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Response);
    return error;
  }
  throw new Error('expected a thrown Response');
}

describe('Shopify cart action', () => {
  it('rejects non-POST methods before any backend call', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      new Request('https://opendrone.be/api/shopify/cart', {method: 'PUT'}),
      ENABLED_ENV,
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, createCart: async () => ({id: 'gid://shopify/Cart/new?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/new', lines: []})},
    ));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
    assert.equal(fetched, false);
  });

  it('is disabled by default', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}),
      {},
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, createCart: async () => ({id: 'gid://shopify/Cart/new?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/new', lines: []})},
    ));
    assert.equal(response.status, 404);
    assert.equal(fetched, false);
  });

  it('keeps catalog preview read-only until the separate write gate opens', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}),
      {SHOPIFY_ADAPTER_PREVIEW: '1'},
      {
        fetchCatalog: async () => {
          fetched = true;
          return CATALOG;
        },
        createCart: async () => {
          throw new Error('must not create');
        },
      },
    ));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(fetched, false);
  });

  it('keeps checkout globally closed by default before catalog access', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}),
      {SHOPIFY_ADAPTER_PREVIEW: '1', SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', SHOPIFY_SHIPPING_LATER_CONFIRMED: '1'},
      {
        fetchCatalog: async () => { fetched = true; return CATALOG; },
        createCart: async () => { throw new Error('must not create'); },
      },
    ));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Checkout is closed.');
    assert.equal(fetched, false);
  });

  it('requires explicit confirmation of the shipping-later Shopify setup', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}),
      {SHOPIFY_ADAPTER_PREVIEW: '1', SHOPIFY_CHECKOUT_WRITE_ENABLED: '1', PUBLIC_COMING_SOON: '0'},
      {
        fetchCatalog: async () => { fetched = true; return CATALOG; },
        createCart: async () => { throw new Error('must not create'); },
      },
    ));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Shipping-later checkout is not confirmed.');
    assert.equal(fetched, false);
  });

  it('rejects a lifecycle-locked product before any Shopify cart mutation', async () => {
    let created = false;
    const locked: Catalog = {
      ...CATALOG,
      products: [{
        ...CATALOG.products[0],
        handle: 'openlink',
        variants: [{...CATALOG.products[0].variants[0], sku: 'LOCKED-SKU'}],
      }],
    };
    PRODUCT_CONTENT.openlink = {status: 'development'} as (typeof PRODUCT_CONTENT)[string];
    try {
      const response = await thrownResponse(handleShopifyCartAction(
        request({sku: 'LOCKED-SKU', qty: '1'}),
        ENABLED_ENV,
        {
          fetchCatalog: async () => locked,
          createCart: async () => { created = true; throw new Error('must not create'); },
        },
      ));
      assert.equal(response.status, 409);
      assert.equal(created, false);
    } finally {
      delete PRODUCT_CONTENT.openlink;
    }
  });

  it('rejects malformed input before fetching the catalog', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '-1'}),
      ENABLED_ENV,
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, createCart: async () => ({id: 'gid://shopify/Cart/new?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/new', lines: []})},
    ));
    assert.equal(response.status, 400);
    assert.equal(fetched, false);
  });

  it('converts an unsupported form body into a safe 400', async () => {
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartAction(
      new Request('https://opendrone.be/api/shopify/cart', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Origin: 'https://opendrone.be'},
        body: '{"sku":"OPENRX-LITE"}',
      }),
      ENABLED_ENV,
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, createCart: async () => ({id: 'gid://shopify/Cart/new?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/new', lines: []})},
    ));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(fetched, false);
  });

  it('rejects an oversized form before fetching the catalog', async () => {
    let fetched = false;
    const oversized = request({sku: 'OPENRX-LITE', qty: '1'});
    oversized.headers.set('Content-Length', '8193');
    const response = await thrownResponse(handleShopifyCartAction(
      oversized,
      ENABLED_ENV,
      {
        fetchCatalog: async () => {
          fetched = true;
          return CATALOG;
        },
        createCart: async () => {
          throw new Error('must not create');
        },
      },
    ));
    assert.equal(response.status, 413);
    assert.equal(fetched, false);
  });

  it('fails closed for an unknown SKU', async () => {
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'UNKNOWN-SKU', qty: '1'}),
      ENABLED_ENV,
      {fetchCatalog: async () => CATALOG, createCart: async () => ({id: 'gid://shopify/Cart/new?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/new', lines: []})},
    ));
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });

  it('turns an upstream failure into a safe 503', async () => {
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}),
      ENABLED_ENV,
      {fetchCatalog: async () => { throw new Error('token must stay private'); }, createCart: async () => ({id: 'gid://shopify/Cart/new?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/new', lines: []})},
    ));
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'Checkout temporarily unavailable.');
    assert.equal(response.headers.get('Retry-After'), '60');
  });

  it('redirects to the cart using request-time catalog identity and ignores a client price', async () => {
    let received: unknown;
    const response = await handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '2', price: '0.01', merchandiseId: 'attacker'}),
      ENABLED_ENV,
      {
        fetchCatalog: async () => CATALOG,
        createCart: async (lines) => {
          received = lines;
          return {id: 'gid://shopify/Cart/new?key=secret', checkoutUrl: 'https://checkout.opendrone.be/checkouts/cn/ok', lines: []};
        },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(received, [{
      merchandiseId: 'gid://shopify/ProductVariant/server-authoritative',
      quantity: 2,
    }]);
  });


  it('rejects a cross-origin POST before backend access', async () => {
    let fetched = false;
    const bad = request({sku: 'OPENRX-LITE', qty: '1'});
    bad.headers.set('Origin', 'https://attacker.test');
    const response = await thrownResponse(handleShopifyCartAction(
      bad, ENABLED_ENV,
      {fetchCatalog: async () => { fetched = true; return CATALOG; }, createCart: async () => { throw new Error('must not create'); }},
    ));
    assert.equal(response.status, 403);
    assert.equal(fetched, false);
  });

  it('merges repeat adds into the existing variant without imposing a quantity cap', async () => {
    let updated: unknown;
    const response = await handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '2'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'gid://shopify/Cart/session-a?key=secret-a',
        getCart: async (id) => ({id, checkoutUrl: 'https://checkout.opendrone.be/a', lines: [{id: 'gid://shopify/CartLine/one', lineIds: ['gid://shopify/CartLine/one'], merchandiseId: 'gid://shopify/ProductVariant/server-authoritative', quantity: 3}]}),
        updateCartLines: async (id, lines) => { updated = {id, lines}; return {id, checkoutUrl: 'https://checkout.opendrone.be/a', lines: []}; },
        addCartLines: async () => { throw new Error('must not create a duplicate line'); },
        createCart: async () => { throw new Error('must not create'); },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(updated, {
      id: 'gid://shopify/Cart/session-a?key=secret-a',
      lines: [{id: 'gid://shopify/CartLine/one', quantity: 5}],
    });

    const mutations: unknown[] = [];
    const unlimited = await handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '10000'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'cart-b',
        getCart: async () => ({
          id: 'cart-b',
          checkoutUrl: 'https://checkout.opendrone.be/b',
          lines: [
            {id: 'gid://shopify/CartLine/a', lineIds: ['gid://shopify/CartLine/a', 'gid://shopify/CartLine/b'], merchandiseId: 'gid://shopify/ProductVariant/server-authoritative', quantity: 49},
          ],
        }),
        updateCartLines: async (id, lines) => {
          mutations.push({kind: 'update', id, lines});
          return {id, checkoutUrl: 'https://checkout.opendrone.be/b', lines: []};
        },
        removeCartLines: async (id, lineIds) => {
          mutations.push({kind: 'remove', id, lineIds});
          return {id, checkoutUrl: 'https://checkout.opendrone.be/b', lines: []};
        },
        addCartLines: async () => { throw new Error('must not create a duplicate line'); },
        createCart: async () => { throw new Error('must not create'); },
      },
    );
    assert.equal(unlimited.status, 200);
    assert.deepEqual(mutations, [
      {kind: 'update', id: 'cart-b', lines: [{id: 'gid://shopify/CartLine/a', quantity: 10049}]},
      {kind: 'remove', id: 'cart-b', lineIds: ['gid://shopify/CartLine/b']},
    ]);
  });

  it('clears an expired session cart and recreates it in the same add request', async () => {
    let unset = false;
    let replacement = '';
    const response = await handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'expired', getCart: async () => null,
        unsetCartId: () => { unset = true; },
        setCartId: (id) => { replacement = id; },
        addCartLines: async () => { throw new Error('must not add'); },
        createCart: async () => ({id: 'replacement', checkoutUrl: 'https://checkout.opendrone.be/a', lines: []}),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(unset, true);
    assert.equal(replacement, 'replacement');
  });

  it('updates and removes existing cart lines without fetching the catalog', async () => {
    let fetched = false;
    let updated: unknown;
    let removed: unknown;
    const base = {
      fetchCatalog: async () => { fetched = true; return CATALOG; },
      createCart: async () => { throw new Error('must not create'); },
      getCartId: () => 'gid://shopify/Cart/cart-a?key=secret',
    };
    const update = await handleShopifyCartAction(
      request({intent: 'update', lineId: 'gid://shopify/CartLine/line-a', quantity: '42'}),
      ENABLED_ENV,
      {
        ...base,
        updateCartLines: async (id, lines) => {
          updated = {id, lines};
          return {id, checkoutUrl: 'https://checkout.opendrone.be/a', lines: []};
        },
      },
    );
    assert.equal(update.status, 303);
    assert.equal(update.headers.get('Location'), '/cart');
    assert.deepEqual(updated, {
      id: 'gid://shopify/Cart/cart-a?key=secret',
      lines: [{id: 'gid://shopify/CartLine/line-a', quantity: 42}],
    });
    const remove = await handleShopifyCartAction(
      request({intent: 'remove', lineId: 'gid://shopify/CartLine/line-a'}),
      ENABLED_ENV,
      {
        ...base,
        removeCartLines: async (id, lineIds) => {
          removed = {id, lineIds};
          return {id, checkoutUrl: 'https://checkout.opendrone.be/a', lines: []};
        },
      },
    );
    assert.equal(remove.status, 303);
    assert.deepEqual(removed, {
      id: 'gid://shopify/Cart/cart-a?key=secret',
      lineIds: ['gid://shopify/CartLine/line-a'],
    });
    assert.equal(fetched, false);
  });

  it('loads the session cart when every commerce gate is open', async () => {
    const response = await handleShopifyCartLoader(ENABLED_ENV, {
      getCartId: () => 'gid://shopify/Cart/cart-a?key=secret',
      getCart: async (id) => ({
        id,
        checkoutUrl: 'https://checkout.opendrone.be/a',
        lines: [],
      }),
    });
    assert.equal(response.status, 200);
    const cart = (await response.json()) as {id: string};
    assert.equal(cart.id, 'gid://shopify/Cart/cart-a?key=secret');
  });

  it('rejects set mode and keeps the cart loader closed when commerce is gated', async () => {
    const invalid = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1', mode: 'set'}),
      ENABLED_ENV,
      {fetchCatalog: async () => CATALOG, createCart: async () => { throw new Error('must not create'); }},
    ));
    assert.equal(invalid.status, 400);
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartLoader(
      {SHOPIFY_ADAPTER_PREVIEW: '1'},
      {getCartId: () => 'cart-a', getCart: async (id) => { fetched = true; return {id, checkoutUrl: 'https://checkout.opendrone.be/a', lines: []}; }},
    ));
    assert.equal(response.status, 404);
    assert.equal(fetched, false);
  });

});
