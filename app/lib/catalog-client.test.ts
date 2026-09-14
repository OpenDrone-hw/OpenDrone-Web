import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import {createCatalogClient, resetCatalogMemo} from './catalog-client.ts';

const ENV = {
  CATALOG_URL: 'https://catalog.test/catalog.json',
  PUBLIC_SHOP_URL: 'https://shop.test',
} as Env;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
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
});
