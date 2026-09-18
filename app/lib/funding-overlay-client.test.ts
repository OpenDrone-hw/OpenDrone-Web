import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import {
  createFundingOverlayClient,
  fundingOverlayUrl,
  resetFundingOverlayMemo,
} from './funding-overlay-client.ts';

const ENV = {
  FUNDING_URL: 'https://funding.test/funding.json',
} as Env;

const originalFetch = globalThis.fetch;
const originalNow = Date.now;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  resetFundingOverlayMemo();
});

describe('funding overlay outage behavior: falls back to the catalog exactly as today', () => {
  it('uses the canonical production origin by default', () => {
    assert.equal(
      fundingOverlayUrl({} as Env),
      'https://erp.incutec.com/incutec/funding.json',
    );
  });

  it('resolves to an empty overlay on a 404 (endpoint not deployed yet), never rejects', async () => {
    globalThis.fetch = async () => new Response('not found', {status: 404});
    const client = createFundingOverlayClient({env: ENV});
    const overlay = await client.get();
    assert.deepEqual(overlay, {updatedAt: null, funding: {}});
  });

  it('remembers a failed fetch for one freshness window instead of refetching on every render', async () => {
    let now = 2_000_000_000_000;
    Date.now = () => now;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('not found', {status: 404});
    };
    const client = createFundingOverlayClient({env: ENV});

    await client.get();
    await client.get();
    await client.get();
    assert.equal(calls, 1, 'a 404 endpoint is asked once per window, not once per page');

    now += 61 * 1000;
    assert.deepEqual(await client.get(), {updatedAt: null, funding: {}});
    assert.equal(calls, 2, 'and asked again once the window has passed');
  });

  it('resolves to an empty overlay when the fetch is aborted (slow endpoint), never rejects', async () => {
    globalThis.fetch = async () => {
      throw new DOMException('The operation was aborted.', 'TimeoutError');
    };
    const client = createFundingOverlayClient({env: ENV});
    const overlay = await client.get();
    assert.deepEqual(overlay, {updatedAt: null, funding: {}});
  });

  it('resolves to an empty overlay when fetch itself throws (endpoint missing/unreachable)', async () => {
    globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const client = createFundingOverlayClient({env: ENV});
    const overlay = await client.get();
    assert.deepEqual(overlay, {updatedAt: null, funding: {}});
  });

  it('parses a successful response', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          schema: 1,
          updated_at: '2026-09-18T12:00:00Z',
          max_age: 60,
          funding: {openrx: {units_funded: 340, pct: 68, state: 'open'}},
        }),
        {status: 200},
      );
    const client = createFundingOverlayClient({env: ENV});
    const overlay = await client.get();
    assert.equal(overlay.updatedAt, '2026-09-18T12:00:00Z');
    assert.deepEqual(overlay.funding, {
      openrx: {
        unitsFunded: 340,
        state: 'open',
        targetUnits: null,
        dateOpen: null,
        dateDeadline: null,
        backers: null,
        amountFunded: null,
        currency: null,
      },
    });
  });

  it('serves the bounded Cache API snapshot across a cold isolate on a failed fetch', async () => {
    const snapshot = {
      schema: 1,
      updated_at: '2026-09-18T11:59:00Z',
      max_age: 60,
      funding: {openrx: {units_funded: 340, pct: 68, state: 'open'}},
    };
    const cache = {
      match: async () =>
        new Response(JSON.stringify(snapshot), {
          headers: {
            'Content-Type': 'application/json',
            'x-funding-age': String(Date.now() - 5 * 60 * 1000),
          },
        }),
      put: async () => undefined,
    } as unknown as Cache;
    let refresh: Promise<unknown> | undefined;
    globalThis.fetch = async () => new Response('down', {status: 503});

    resetFundingOverlayMemo();
    const client = createFundingOverlayClient({
      env: ENV,
      cache,
      waitUntil: (promise) => {
        refresh = promise;
      },
    });
    const overlay = await client.get();

    assert.deepEqual(overlay.funding, {
      openrx: {
        unitsFunded: 340,
        state: 'open',
        targetUnits: null,
        dateOpen: null,
        dateDeadline: null,
        backers: null,
        amountFunded: null,
        currency: null,
      },
    });
    assert.ok(refresh, 'stale cache schedules a background refresh');
    await refresh;
  });

  it('falls back to an empty overlay once the stale cache ages past the fallback window', async () => {
    const now = 2_000_000_000_000;
    Date.now = () => now;
    const snapshot = {
      schema: 1,
      updated_at: '2026-09-18T00:00:00Z',
      max_age: 60,
      funding: {openrx: {units_funded: 340, pct: 68, state: 'open'}},
    };
    const fetchedAt = now - 61 * 60 * 1000; // older than the 1h fallback window
    const cache = {
      match: async () =>
        new Response(JSON.stringify(snapshot), {
          headers: {'x-funding-age': String(fetchedAt)},
        }),
      put: async () => undefined,
    } as unknown as Cache;
    globalThis.fetch = async () => new Response('down', {status: 503});
    const client = createFundingOverlayClient({env: ENV, cache});

    const overlay = await client.get();
    assert.deepEqual(overlay, {updatedAt: null, funding: {}});
  });

  it('sends Basic auth (shared with the catalog) and rejects redirects', async () => {
    const seen: Array<{authorization: string | null; redirect?: RequestRedirect}> = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push({
        authorization: request.headers.get('authorization'),
        redirect: init?.redirect,
      });
      return new Response(
        JSON.stringify({schema: 1, updated_at: null, max_age: 60, funding: {}}),
        {status: 200},
      );
    };
    const protectedEnv = {
      ...ENV,
      CATALOG_HTTP_USER: 'preview',
      CATALOG_HTTP_PASSWORD: 'secret',
    } as Env;

    await createFundingOverlayClient({env: protectedEnv}).get();

    assert.match(seen[0].authorization ?? '', /^Basic /);
    assert.equal(seen[0].redirect, 'manual');
  });
});
