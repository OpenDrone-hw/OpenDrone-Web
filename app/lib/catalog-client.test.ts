import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import {createCatalogClient, resetCatalogMemo} from './catalog-client.ts';

const ENV = {
  CATALOG_URL: 'https://catalog.test/catalog.json',
  PUBLIC_SHOP_URL: 'https://shop.test',
} as Env;

const originalFetch = globalThis.fetch;
const originalNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  resetCatalogMemo();
});

describe('catalog outage behavior', () => {
  it('returns 503 on a cold miss instead of an empty catalog', async () => {
    globalThis.fetch = async () => new Response('down', {status: 503});
    const client = createCatalogClient({env: ENV});
    await assert.rejects(client.get(), (error: unknown) => {
      assert.ok(error instanceof Response);
      assert.equal(error.status, 503);
      assert.equal(error.headers.get('Retry-After'), '60');
      return true;
    });
  });

  it('serves the bounded Cache API snapshot across a cold isolate', async () => {
    const snapshot = {
      schema: 1,
      generated_at: '2026-09-15T00:00:00Z',
      max_age: 300,
      currency: 'EUR',
      prices_include_vat: true,
      shop_url: 'https://shop.test',
      cart_url: 'https://shop.test/shop/cart',
      add_url: 'https://shop.test/incutec/add',
      add_method: 'POST',
      products: [],
    };
    const cache = {
      match: async () => new Response(JSON.stringify(snapshot), {
        headers: {
          'Content-Type': 'application/json',
          'x-catalog-age': String(Date.now() - 10 * 60 * 1000),
        },
      }),
      put: async () => undefined,
    } as unknown as Cache;
    let refresh: Promise<unknown> | undefined;
    globalThis.fetch = async () => new Response('down', {status: 503});

    resetCatalogMemo();
    const client = createCatalogClient({
      env: ENV,
      cache,
      waitUntil: (promise) => {
        refresh = promise;
      },
    });
    const catalog = await client.get();

    assert.equal(catalog.generated_at, snapshot.generated_at);
    assert.ok(refresh, 'stale cache schedules a background refresh');
    await refresh;
  });

  it('does not renew the hard stale deadline when a cache hit enters memory', async () => {
    let now = 2_000_000_000_000;
    Date.now = () => now;
    const snapshot = {
      schema: 1,
      generated_at: '2026-09-15T00:00:00Z',
      max_age: 300,
      currency: 'EUR',
      prices_include_vat: true,
      shop_url: 'https://shop.test',
      cart_url: 'https://shop.test/shop/cart',
      add_url: 'https://shop.test/incutec/add',
      add_method: 'POST',
      products: [],
    };
    const fetchedAt = now - 59 * 60 * 1000;
    const cache = {
      match: async () => new Response(JSON.stringify(snapshot), {
        headers: {'x-catalog-age': String(fetchedAt)},
      }),
      put: async () => undefined,
    } as unknown as Cache;
    globalThis.fetch = async () => new Response('down', {status: 503});
    const client = createCatalogClient({env: ENV, cache});

    assert.equal((await client.get()).generated_at, snapshot.generated_at);
    now += 2 * 60 * 1000;
    await assert.rejects(client.get(), (error: unknown) => {
      assert.ok(error instanceof Response);
      assert.equal(error.status, 503);
      return true;
    });
  });

  it('scopes memoized catalogs by URL and sends Basic auth only to that URL', async () => {
    const seen: Array<{url: string; authorization: string | null; redirect?: RequestRedirect}> = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        redirect: init?.redirect,
      });
      return new Response(JSON.stringify({
        schema: 1,
        generated_at: request.url,
        max_age: 300,
        currency: 'EUR',
        prices_include_vat: true,
        shop_url: 'https://shop.test',
        cart_url: 'https://shop.test/shop/cart',
        add_url: 'https://shop.test/incutec/add',
        add_method: 'POST',
        products: [],
      }), {status: 200});
    };
    const protectedEnv = {
      ...ENV,
      CATALOG_URL: 'https://staging.test/catalog.json',
      CATALOG_HTTP_USER: 'preview',
      CATALOG_HTTP_PASSWORD: 'secret',
    } as Env;
    const publicEnv = {...ENV, CATALOG_URL: 'https://prod.test/catalog.json'} as Env;

    const [preview, production] = await Promise.all([
      createCatalogClient({env: protectedEnv}).get(),
      createCatalogClient({env: publicEnv}).get(),
    ]);

    assert.equal(preview.generated_at, protectedEnv.CATALOG_URL);
    assert.equal(production.generated_at, publicEnv.CATALOG_URL);
    assert.match(seen[0].authorization ?? '', /^Basic /);
    assert.equal(seen[1].authorization, null);
    assert.ok(seen.every((entry) => entry.redirect === 'manual'));
  });
});
