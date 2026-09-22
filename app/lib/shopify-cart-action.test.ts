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
  SHOPIFY_CHECKOUT_WRITE_ENABLED: '1',
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
      {},
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
      {SHOPIFY_CHECKOUT_WRITE_ENABLED: '1'},
      {
        fetchCatalog: async () => { fetched = true; return CATALOG; },
        createCart: async () => { throw new Error('must not create'); },
      },
    ));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'Checkout is closed.');
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

  it('redirects to checkout using request-time catalog identity and ignores a client price', async () => {
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
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('Location'), 'https://checkout.opendrone.be/checkouts/cn/ok');
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

  it('reuses only the cart id from this session and enforces cumulative quantity', async () => {
    let addedTo = '';
    const response = await handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '2'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'gid://shopify/Cart/session-a?key=secret-a',
        getCart: async (id) => ({id, checkoutUrl: 'https://checkout.opendrone.be/a', lines: [{merchandiseId: 'gid://shopify/ProductVariant/server-authoritative', quantity: 3}]}),
        addCartLines: async (id) => { addedTo = id; return {id, checkoutUrl: 'https://checkout.opendrone.be/a', lines: []}; },
        createCart: async () => { throw new Error('must not create'); },
      },
    );
    assert.equal(response.status, 303);
    assert.equal(addedTo, 'gid://shopify/Cart/session-a?key=secret-a');

    const over = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '2'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'cart-b',
        getCart: async () => ({
          id: 'cart-b',
          checkoutUrl: 'https://checkout.opendrone.be/b',
          lines: [
            {merchandiseId: 'gid://shopify/ProductVariant/server-authoritative', quantity: 30},
            {merchandiseId: 'gid://shopify/ProductVariant/server-authoritative', quantity: 19},
          ],
        }),
        addCartLines: async () => { throw new Error('must not add'); },
        createCart: async () => { throw new Error('must not create'); },
      },
    ));
    assert.equal(over.status, 400);
  });

  it('fails closed and clears an expired session cart without creating another', async () => {
    let unset = false;
    const response = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1'}), ENABLED_ENV, {
        fetchCatalog: async () => CATALOG,
        getCartId: () => 'expired', getCart: async () => null,
        unsetCartId: () => { unset = true; },
        addCartLines: async () => { throw new Error('must not add'); },
        createCart: async () => { throw new Error('must not create'); },
      },
    ));
    assert.equal(response.status, 409);
    assert.equal(unset, true);
  });

  it('rejects set mode and permanently closes the legacy cart loader', async () => {
    const invalid = await thrownResponse(handleShopifyCartAction(
      request({sku: 'OPENRX-LITE', qty: '1', mode: 'set'}),
      ENABLED_ENV,
      {fetchCatalog: async () => CATALOG, createCart: async () => { throw new Error('must not create'); }},
    ));
    assert.equal(invalid.status, 400);
    let fetched = false;
    const response = await thrownResponse(handleShopifyCartLoader(
      {},
      {getCartId: () => 'cart-a', getCart: async (id) => { fetched = true; return {id, checkoutUrl: 'https://checkout.opendrone.be/a', lines: []}; }},
    ));
    assert.equal(response.status, 410);
    assert.equal(fetched, false);
  });

});
