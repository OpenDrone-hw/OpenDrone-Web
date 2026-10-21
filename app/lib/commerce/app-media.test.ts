import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {handleAppMedia, mediaPath} from './app-media.ts';
import type {AppEnv} from './app-api.ts';

const ENV = {COMMERCE_SOURCE: 'app', APP_API_URL: 'https://app.example', APP_ACCESS_CLIENT_ID: 'id', APP_ACCESS_CLIENT_SECRET: 'sec', APP_STOREFRONT_TOKEN: 'tok'} as unknown as AppEnv;
const SHA = 'a'.repeat(64);
const get = (path: string, method = 'GET') => new Request(`https://shop.example${path}`, {method});

function memoryCache(): Cache & {puts: number} {
  const m = new Map<string, Response>();
  return {
    puts: 0,
    async match(r: Request) { return m.get(r.url)?.clone(); },
    async put(r: Request, res: Response) { (this as {puts: number}).puts++; m.set(r.url, res); },
  } as unknown as Cache & {puts: number};
}

describe('app media proxy', () => {
  it('names the path with APP_MEDIA_PATH, default /shop-media', () => {
    assert.equal(mediaPath({}), '/shop-media');
    assert.equal(mediaPath({APP_MEDIA_PATH: 'img/'}), '/img');
  });

  it('proxies a copy with the service headers, passes the cache headers and caches at the edge', async () => {
    let seen: {url: string; headers: Record<string, string>} | null = null;
    let calls = 0;
    const fetcher = (async (url: string, init: RequestInit) => {
      calls++;
      seen = {url, headers: init.headers as Record<string, string>};
      return new Response('PNG', {headers: {'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'set-cookie': 'x=1'}});
    }) as unknown as typeof fetch;
    const cache = memoryCache();
    const kept: Promise<unknown>[] = [];
    const res = (await handleAppMedia(get(`/shop-media/${SHA}.png`), ENV, cache, fetcher, (w) => kept.push(w)))!;
    await Promise.all(kept);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control') ?? '', /immutable/);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(seen!.url, `https://app.example/media/site/${SHA}.png`);
    assert.equal(seen!.headers.authorization, 'Bearer tok');
    assert.equal(seen!.headers['CF-Access-Client-Id'], 'id');
    const again = (await handleAppMedia(get(`/shop-media/${SHA}.png`), ENV, cache, fetcher))!;
    assert.equal(await again.text(), 'PNG');
    assert.equal(calls, 1);
  });

  it('serves only <64 hex>.<ext> names and GET or HEAD; everything else is 404', async () => {
    const fetcher = (async () => { throw new Error('must not call the app'); }) as unknown as typeof fetch;
    for (const path of [`/shop-media/${SHA}`, '/shop-media/x.png', `/shop-media/${SHA}.png/extra`, '/shop-media/']) {
      assert.equal((await handleAppMedia(get(path), ENV, null, fetcher))!.status, 404, path);
    }
    assert.equal((await handleAppMedia(get(`/shop-media/${SHA}.png`, 'POST'), ENV, null, fetcher))!.status, 404);
  });

  it('refuses a non-image answer and an unknown copy, and leaves other paths and Shopify mode alone', async () => {
    const html = (async () => new Response('<html>', {headers: {'content-type': 'text/html'}})) as unknown as typeof fetch;
    assert.equal((await handleAppMedia(get(`/shop-media/${SHA}.png`), ENV, null, html))!.status, 404);
    const missing = (async () => new Response('{}', {status: 404, headers: {'content-type': 'application/json'}})) as unknown as typeof fetch;
    assert.equal((await handleAppMedia(get(`/shop-media/${SHA}.png`), ENV, null, missing))!.status, 404);
    assert.equal(await handleAppMedia(get('/products'), ENV, null, html), null);
    assert.equal(await handleAppMedia(get(`/shop-media/${SHA}.png`), {...ENV, COMMERCE_SOURCE: 'shopify'} as AppEnv, null, html), null);
  });
});
