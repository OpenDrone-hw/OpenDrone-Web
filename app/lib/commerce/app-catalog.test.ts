import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import {byHandle, bySku, toCards} from '../catalog.ts';
import {clearCatalogMemo} from '../catalog-memo.ts';
import {appCartSummary, handleAppCartAction, handleAppCartLoader, linesFromForm} from './app-cart.ts';
import {appCatalogClient, mapAppCatalog, type AppCatalogWire} from './app-catalog.ts';
import {cleanLines, readCart, returnOrigin, writeCart, type AppEnv} from './app-api.ts';

const WIRE: AppCatalogWire = {
  currency: 'EUR',
  version: 'v1',
  products: [
    {
      id: 'p-board',
      handle: 'test-board',
      title: 'Test Flight Board',
      type: 'Board',
      description_html: '<p>Sample&nbsp;board.</p>',
      image: {url: 'https://img.example/a.jpg', alt: 'Board'},
      media: [{url: 'https://img.example/a.jpg', alt: 'Board'}, {url: 'https://img.example/b.jpg', alt: ''}],
      variants: [
        {id: 'v1', sku: 'B-1', title: 'Small', price: '49.90', price_minor: 4990, compare_at_minor: 5900, available: true, options: {Size: 'Small'}},
        {id: 'v2', sku: 'B-2', title: 'Large', price: '69.90', price_minor: 6990, compare_at_minor: null, available: false, options: {Size: 'Large'}},
        {id: 'v3', sku: 'B-3', title: 'No price', price: null, price_minor: null, available: true, options: {}},
      ],
    },
  ],
};

const ENV = {
  COMMERCE_SOURCE: 'app',
  APP_API_URL: 'https://app.example',
  APP_PROJECT: 'proj',
  APP_STOREFRONT_TOKEN: 'bearer',
  SESSION_SECRET: 'test-secret',
} as unknown as Env;

describe('app catalog mapping', () => {
  it('maps products into the Catalog the site renders: EUR, no Shopify fields', () => {
    const catalog = mapAppCatalog(WIRE, new Date('2026-01-01T00:00:00Z'));
    assert.equal(catalog.currency, 'EUR');
    assert.equal(catalog.prices_include_vat, true);
    assert.equal(catalog.add_url, '/api/shopify/cart');
    assert.equal(catalog.cart_url, '/shop/cart');
    assert.deepEqual(catalog.campaign_skus, []);
    const product = byHandle(catalog, 'test-board');
    assert.ok(product);
    assert.equal(product.family, 'Board');
    assert.equal(product.description, 'Sample board.');
    assert.deepEqual(product.images, ['https://img.example/a.jpg', 'https://img.example/b.jpg']);
    // A variant with no price is never sold at 0: it is dropped.
    assert.deepEqual(product.variants.map((v) => v.sku), ['B-1', 'B-2']);
    const small = bySku(catalog, 'B-1')!.variant;
    assert.equal(small.price, 49.9);
    assert.equal(small.compare_price, 59);
    assert.equal(small.availability, 'in_stock');
    assert.equal(small.ship_promise, null);
    assert.equal(small.merchandise_id, 'v1');
    assert.equal(small.cart_add_url, '/api/shopify/cart?sku=B-1&qty=1');
    assert.equal(bySku(catalog, 'B-2')!.variant.availability, 'sold_out');
    assert.equal(toCards(catalog).length, 1);
  });

  it('rejects a document that is not a catalog', () => {
    assert.throws(() => mapAppCatalog({} as AppCatalogWire));
  });
});

describe('catalog client in app mode', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    clearCatalogMemo();
  });

  it('reads storefront.catalog from the app for every region and never calls Shopify', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ok: true, data: WIRE}), {headers: {'content-type': 'application/json'}});
    }) as unknown as typeof fetch;
    // No Shopify configuration at all, and every region asked for.
    const client = appCatalogClient(ENV);
    assert.equal(client.region, 'EU');
    for (const catalog of [await client.forBuyer(), await client.get(), await client.forRegion('US'), await client.fresh.forRegion('INT', 'JP')]) {
      assert.equal(catalog.currency, 'EUR');
      assert.equal(catalog.products[0].variants[0].price, 49.9);
    }
    assert.ok(urls.length > 0);
    for (const url of urls) assert.equal(url, 'https://app.example/api/ops/storefront.catalog');
  });
});

describe('app cart on the buy buttons', () => {
  const catalog = mapAppCatalog(WIRE);
  const cartEnv = ENV as unknown as AppEnv;
  const post = (fields: Record<string, string>, cookie = '') =>
    new Request('https://shop.example/api/shopify/cart', {
      method: 'POST',
      headers: {Origin: 'https://shop.example', 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? {Cookie: cookie} : {})},
      body: new URLSearchParams(fields),
    });

  it('resolves SKUs to app variants and refuses unknown or sold out ones', async () => {
    assert.deepEqual(linesFromForm(new URLSearchParams({sku: 'B-1', qty: '2'}) as unknown as FormData, catalog), [{variant: 'v1', qty: 2}]);
    assert.throws(() => linesFromForm(new URLSearchParams({sku: 'nope'}) as unknown as FormData, catalog), (r: unknown) => r instanceof Response && r.status === 404);
    assert.throws(() => linesFromForm(new URLSearchParams({sku: 'B-2'}) as unknown as FormData, catalog), (r: unknown) => r instanceof Response && r.status === 409);
    assert.throws(() => linesFromForm(new URLSearchParams({sku: 'B-1', qty: '0'}) as unknown as FormData, catalog), (r: unknown) => r instanceof Response && r.status === 400);
  });

  it('adds to the signed cart cookie and answers the summary, then the header count', async () => {
    const res = await handleAppCartAction(post({sku: 'B-1', qty: '2', response: 'summary'}), cartEnv, catalog);
    const summary = (await res.json()) as {totalQuantity: number; subtotal: {amount: string; currencyCode: string}; lines: Array<{sku: string}>};
    assert.equal(summary.totalQuantity, 2);
    assert.deepEqual(summary.subtotal, {amount: '99.80', currencyCode: 'EUR'});
    assert.equal(summary.lines[0].sku, 'B-1');
    const cookie = res.headers.get('Set-Cookie')!.split(';', 1)[0];
    assert.deepEqual(await readCart(new Request('https://shop.example/', {headers: {Cookie: cookie}}), cartEnv), [{variant: 'v1', qty: 2}]);
    const again = await handleAppCartAction(post({sku: 'B-1', qty: '1'}, cookie), cartEnv, catalog);
    assert.equal(again.status, 303);
    assert.equal(again.headers.get('Location'), '/shop/cart');
    const count = await handleAppCartLoader(new Request('https://shop.example/api/shopify/cart?summary=1', {headers: {Cookie: cookie}}), cartEnv, async () => catalog);
    assert.equal(((await count.json()) as {totalQuantity: number}).totalQuantity, 2);
    const empty = await handleAppCartLoader(new Request('https://shop.example/api/shopify/cart?summary=1'), cartEnv, async () => catalog);
    assert.equal(((await empty.json()) as {totalQuantity: number}).totalQuantity, 0);
  });

  it('sends the drawer checkout to the app cart and refuses a foreign origin', async () => {
    const res = await handleAppCartAction(post({intent: 'checkout'}), cartEnv, catalog);
    assert.equal(res.headers.get('Location'), '/shop/cart');
    const foreign = new Request('https://shop.example/api/shopify/cart', {method: 'POST', headers: {Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded'}, body: 'sku=B-1'});
    await assert.rejects(handleAppCartAction(foreign, cartEnv, catalog), (r: unknown) => r instanceof Response && r.status === 403);
  });

  it('summarises only lines the catalog knows', () => {
    const summary = appCartSummary([{variant: 'v1', qty: 1}, {variant: 'gone', qty: 3}], catalog);
    assert.equal(summary.totalQuantity, 1);
    assert.equal(cleanLines([{variant: 'v1', qty: 1}]).length, 1);
    assert.equal(typeof writeCart, 'function');
  });
});

describe('checkout return origin', () => {
  it('names a plain http dev origin as https only in dev, never in a build', () => {
    assert.equal(returnOrigin('http://127.0.0.1:5181', true), 'https://127.0.0.1:5181');
    assert.equal(returnOrigin('http://127.0.0.1:5181', false), 'http://127.0.0.1:5181');
    assert.equal(returnOrigin('https://shoptest.example', false), 'https://shoptest.example');
  });
});
