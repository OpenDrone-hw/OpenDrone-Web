import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import {byHandle, bySku, thirdPartyBrand, toCards, toProduct, selectedOptionsFromRequest} from '../catalog.ts';
import {clearCatalogMemo} from '../catalog-memo.ts';
import {readOptions} from './app-cart-options.ts';
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

// Option shapes as the app's storefront.catalog sends them on the test shop: one axis (Model) with inch marks in
// the values, and two axes (Part, Size).
const OPTION_WIRE: AppCatalogWire = {
  currency: 'EUR',
  products: [
    {
      id: 'p-frame',
      handle: 'openframe',
      title: 'OpenFrame',
      variants: [
        {id: 'f5', sku: 'OPENFRAME-5', title: '5" Freestyle', price_minor: 4410, available: true, options: {Model: '5" Freestyle'}},
        {id: 'f3', sku: 'OPENFRAME-3', title: '3" Freestyle', price_minor: 3510, available: true, options: {Model: '3" Freestyle'}},
      ],
    },
    {
      id: 'p-spares',
      handle: 'openframe-spares',
      title: 'OpenFrame spares',
      variants: [
        {id: 's1', sku: 'ACC-FRM-ARM-3', price_minor: 400, available: true, options: {Part: 'Arm', Size: '3"'}},
        {id: 's2', sku: 'ACC-FRM-ARM-5', price_minor: 600, available: true, options: {Part: 'Arm', Size: '5"'}},
        {id: 's3', sku: 'ACC-FRM-TOP-3', price_minor: 450, available: true, options: {Part: 'Top plate', Size: '3"'}},
        {id: 's4', sku: 'ACC-FRM-TOP-5', price_minor: 450, available: true, options: {Part: 'Top plate', Size: '5"'}},
      ],
    },
  ],
};

describe('product page option params in app mode', () => {
  const catalog = mapAppCatalog(OPTION_WIRE);
  const pick = (handle: string, search: string) => {
    const request = new Request(`https://shop.example/products/${handle}${search}`);
    const product = toProduct(catalog, byHandle(catalog, handle)!, selectedOptionsFromRequest(request));
    return product.selectedOrFirstAvailableVariant?.sku;
  };

  it('keeps the option names on every mapped variant', () => {
    const frame = byHandle(catalog, 'openframe')!;
    assert.deepEqual(frame.variants.map((v) => v.options), [{Model: '5" Freestyle'}, {Model: '3" Freestyle'}]);
  });

  it('selects the variant a one-option link names, percent encoded as a product card writes it', () => {
    assert.equal(pick('openframe', '?Model=3%22%20Freestyle'), 'OPENFRAME-3');
    assert.equal(pick('openframe', '?Model=5%22%20Freestyle'), 'OPENFRAME-5');
    assert.equal(pick('openframe', '?model=3%22+freestyle'), 'OPENFRAME-3');
  });

  it('selects the variant a two-option link names', () => {
    assert.equal(pick('openframe-spares', '?Part=Top%20plate&Size=5%22'), 'ACC-FRM-TOP-5');
    assert.equal(pick('openframe-spares', '?Part=Arm&Size=3%22'), 'ACC-FRM-ARM-3');
  });

  it('falls back to the default variant, never a 404, for an unknown value or an unrelated param', () => {
    assert.equal(pick('openframe', '?Model=9%22%20Nope'), 'OPENFRAME-5');
    assert.equal(pick('openframe', '?image=2&country=BE'), 'OPENFRAME-5');
    assert.equal(pick('openframe-spares', '?Part=Arm&Size=9%22'), 'ACC-FRM-ARM-3');
  });

  it('every variant resolves from the option query its own selector writes', () => {
    for (const entry of catalog.products) {
      for (const variant of entry.variants) {
        const query = new URLSearchParams(variant.options).toString();
        assert.equal(pick(entry.handle, `?${query}`), variant.sku);
      }
    }
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

  it('maps the app campaign fields: preorder state, step price, ship promise, campaign state, counts', () => {
    const wire: AppCatalogWire = {
      currency: 'EUR',
      campaign_skus: ['P-1', 'P-2'],
      campaign_counts: 'verified',
      products: [{id: 'p', handle: 'pre', title: 'Pre', variants: [
        {id: 'a', sku: 'P-1', title: 'A', price_minor: 4320, compare_at_minor: 5400, available: true, sale_mode: 'preorder', ship_promise: 'ships early November 2026',
         campaign: {ordered: 10, batch: 1, price: 43.2, earlyPrice: true, shipPromise: 'ships early November 2026'} as never},
        {id: 'b', sku: 'P-2', title: 'B', price_minor: 5400, compare_at_minor: 5400, available: false, sale_mode: 'sold_out', ship_promise: 'ships x', closed_reason: 'funding_closed'},
        {id: 'c', sku: 'P-3', title: 'C', price_minor: 900, available: true, sale_mode: 'in_stock'},
      ]}],
    };
    const catalog = mapAppCatalog(wire);
    assert.deepEqual(catalog.campaign_skus, ['P-1', 'P-2']);
    assert.equal(catalog.campaign_counts, 'verified');
    const a = bySku(catalog, 'P-1')!.variant;
    assert.equal(a.availability, 'preorder');
    assert.equal(a.price, 43.2);
    assert.equal(a.ship_promise, 'ships early November 2026');
    assert.equal(a.campaign?.price, 43.2);
    const b = bySku(catalog, 'P-2')!.variant;
    assert.equal(b.availability, 'sold_out');
    assert.equal(b.ship_promise, null);
    assert.equal(b.campaign, null);
    assert.equal(bySku(catalog, 'P-3')!.variant.availability, 'in_stock');
    const summary = appCartSummary([{variant: 'a', qty: 2}], catalog);
    assert.equal(summary.lines[0].shipPromise, 'ships early November 2026');
    assert.deepEqual(summary.subtotal, {amount: '86.40', currencyCode: 'EUR'});
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

  it('keeps the first-touch attributes with the app cart, validated, first touch wins', async () => {
    const res = await handleAppCartAction(post({sku: 'B-1', qty: '1', response: 'summary', attr_ref: 'creator-1', attr_utmSource: 'youtube', attr_landing: '/x'}), cartEnv, catalog);
    const cookies = res.headers.getSetCookie().map((c) => c.split(';', 1)[0]);
    assert.equal(cookies.length, 2);
    const req = new Request('https://shop.example/', {headers: {Cookie: cookies.join('; ')}});
    assert.deepEqual((await readOptions(req, cartEnv)).attributes, {_ref: 'creator-1', _utm_source: 'youtube', _landing: '/x'});
    const later = await handleAppCartAction(post({sku: 'B-1', attr_ref: 'other', attr_campaign: 'c1'}, cookies.join('; ')), cartEnv, catalog);
    const next = later.headers.getSetCookie().map((c) => c.split(';', 1)[0]);
    const r2 = new Request('https://shop.example/', {headers: {Cookie: next.join('; ')}});
    assert.deepEqual((await readOptions(r2, cartEnv)).attributes, {_ref: 'creator-1', _utm_source: 'youtube', _landing: '/x', _utm_campaign: 'c1'});
    // A direct visit is the landing marker alone (and a referrer host when there is one).
    const direct = await handleAppCartAction(post({sku: 'B-1', qty: '1', response: 'summary', attr_landing: '/products/b-1', attr_referrer: 'www.google.com'}), cartEnv, catalog);
    const dc = direct.headers.getSetCookie().map((c) => c.split(';', 1)[0]);
    assert.deepEqual((await readOptions(new Request('https://shop.example/', {headers: {Cookie: dc.join('; ')}}), cartEnv)).attributes, {_referrer: 'www.google.com', _landing: '/products/b-1'});
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

describe('app catalog variant photos', () => {
  const media = [
    {url: 'https://img.example/lite-front.jpg', alt: 'Board Lite, front'},
    {url: 'https://img.example/ufl-front.jpg', alt: 'Board Lite-UFL, front'},
    {url: 'https://img.example/x-front.jpg', alt: 'Board 30x30, front'},
  ];
  const wire = (variants: any[]): AppCatalogWire => ({
    products: [{id: 'p', handle: 'board', title: 'Board', image: media[0], media, variants}],
  });
  const v = (sku: string, options: Record<string, string>, image?: {url: string}) =>
    ({id: sku, sku, title: sku, price_minor: 100, available: true, options, image});

  it('gives each variant the photo whose alt names its option as a whole word', () => {
    const catalog = mapAppCatalog(wire([v('A', {Model: 'Lite'}), v('B', {Model: 'Lite-UFL'}), v('C', {Model: '30×30'})]));
    assert.equal(bySku(catalog, 'A')!.variant.image, 'https://img.example/lite-front.jpg');
    assert.equal(bySku(catalog, 'B')!.variant.image, 'https://img.example/ufl-front.jpg');
    assert.equal(bySku(catalog, 'C')!.variant.image, 'https://img.example/x-front.jpg');
  });

  it('prefers the app\'s own variant photo and falls back to the first product photo', () => {
    const catalog = mapAppCatalog(wire([v('A', {Model: 'Lite'}, {url: 'https://img.example/own.jpg'}), v('B', {Model: 'Other'})]));
    assert.equal(bySku(catalog, 'A')!.variant.image, 'https://img.example/own.jpg');
    assert.equal(bySku(catalog, 'B')!.variant.image, 'https://img.example/lite-front.jpg');
  });
});

describe('app catalog vendor', () => {
  const wire = (vendor?: string | null): AppCatalogWire => ({
    products: [{id: 'p', handle: 'prop', title: 'Prop', vendor, variants: [{id: 'v', sku: 'S', price_minor: 100, available: true}]}],
  });

  it('carries the third-party brand to the product page and its JSON-LD', () => {
    const catalog = mapAppCatalog(wire(' HQProp '));
    assert.equal(byHandle(catalog, 'prop')!.vendor, 'HQProp');
    assert.equal(thirdPartyBrand(toProduct(catalog, byHandle(catalog, 'prop')!, []).vendor), 'HQProp');
  });

  it('maps the empty vendor of the house brand to none', () => {
    assert.equal(byHandle(mapAppCatalog(wire('')), 'prop')!.vendor, null);
    assert.equal(byHandle(mapAppCatalog(wire(undefined)), 'prop')!.vendor, null);
  });
});
