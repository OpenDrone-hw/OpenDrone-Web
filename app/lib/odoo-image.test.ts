import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  catalogImageUrls,
  handleOdooImage,
  parseImageRoute,
  toStorefrontImageUrl,
  warmOdooImages,
} from './odoo-image.ts';

const SITE = 'https://opendrone.be';
const ENV = {PUBLIC_SHOP_URL: 'https://shop.test'};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** Minimal in-memory Cache API: keyed by URL, stores cloned responses. */
function memoryCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (key: Request) => store.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => {
      store.set(key.url, response.clone());
    },
  } as unknown as Cache;
  return {cache, store};
}

type Seen = {url: string; authorization: string | null; redirect?: RequestRedirect};

function okFetcher(seen: Seen[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    });
    return new Response(PNG, {status: 200, headers: {'Content-Type': 'image/png'}});
  }) as typeof fetch;
}

/** Odoo unreachable: the connection itself fails, as during a restart. */
const downFetcher = (async () => {
  throw new TypeError('fetch failed: connect ECONNREFUSED');
}) as typeof fetch;

const get = (path: string, method = 'GET') => new Request(`${SITE}${path}`, {method});

describe('toStorefrontImageUrl', () => {
  it('rewrites allowlisted Odoo image URLs to the same-origin route', () => {
    assert.equal(
      toStorefrontImageUrl('https://shop.incutec.com/web/image/product.template/3/image_1024?unique=ce9c438'),
      '/img/odoo/product.template/3/image_1024?unique=ce9c438',
    );
    assert.equal(
      toStorefrontImageUrl('https://shop.incutec.com/web/image/product.image/12/image_512'),
      '/img/odoo/product.image/12/image_512',
    );
  });

  it('leaves anything outside the allowlist untouched', () => {
    for (const url of [
      'https://shop.incutec.com/web/image/res.partner/3/image_1024',
      'https://shop.incutec.com/web/image/product.template/3/datas',
      'https://shop.incutec.com/web/content/42',
      '/local.png',
      'not a url',
    ]) {
      assert.equal(toStorefrontImageUrl(url), url);
    }
  });
});

describe('parseImageRoute', () => {
  it('rejects models, fields, ids and hashes outside the allowlist', () => {
    for (const path of [
      '/img/odoo/res.users/1/image_1024',
      '/img/odoo/product.template/1/avatar_128',
      '/img/odoo/product.template/0/image_1024',
      '/img/odoo/product.template/1a/image_1024',
      '/img/odoo/product.template/1/image_1024/extra',
      '/img/odoo/product.template/1/image_1024?unique=../../x',
    ]) {
      assert.equal(parseImageRoute(new URL(path, SITE)), null, path);
    }
  });
});

describe('handleOdooImage', () => {
  it('404s a disallowed path without touching Odoo', async () => {
    const seen: Seen[] = [];
    const res = await handleOdooImage(get('/img/odoo/res.partner/1/image_1024'), {
      env: ENV,
      fetcher: okFetcher(seen),
    });
    assert.equal(res.status, 404);
    assert.equal(seen.length, 0);
  });

  it('fetches once from Odoo, then serves from the cache with a public TTL', async () => {
    const {cache} = memoryCache();
    const seen: Seen[] = [];
    const deps = {env: ENV, cache, fetcher: okFetcher(seen)};
    const path = '/img/odoo/product.template/3/image_1024?unique=ce9c438';

    const first = await handleOdooImage(get(path), deps);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/png');
    assert.match(first.headers.get('cache-control') ?? '', /^public, max-age=31536000, immutable$/);
    assert.equal(first.headers.get('x-image-source'), 'origin');
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), PNG);
    assert.equal(seen[0].url, 'https://shop.test/web/image/product.template/3/image_1024?unique=ce9c438');
    assert.equal(seen[0].redirect, 'manual');

    const second = await handleOdooImage(get(path), deps);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-image-source'), 'cache');
    assert.equal(seen.length, 1, 'a cached hash never goes back to Odoo');
  });

  it('keeps serving a cached image while Odoo is unreachable', async () => {
    const {cache} = memoryCache();
    const path = '/img/odoo/product.image/1/image_1024?unique=2012ef4';
    await handleOdooImage(get(path), {env: ENV, cache, fetcher: okFetcher()});

    const res = await handleOdooImage(get(path), {env: ENV, cache, fetcher: downFetcher});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
  });

  it('serves the last known image when Odoo is down and the hash changed', async () => {
    const {cache} = memoryCache();
    await handleOdooImage(get('/img/odoo/product.template/3/image_1024?unique=old'), {
      env: ENV,
      cache,
      fetcher: okFetcher(),
    });

    const res = await handleOdooImage(get('/img/odoo/product.template/3/image_1024?unique=new'), {
      env: ENV,
      cache,
      fetcher: downFetcher,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-image-source'), 'stale');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
  });

  it('returns an uncacheable placeholder only when nothing was ever cached', async () => {
    const {cache, store} = memoryCache();
    const res = await handleOdooImage(get('/img/odoo/product.template/9/image_1024?unique=abc'), {
      env: ENV,
      cache,
      fetcher: downFetcher,
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-image-fallback'), 'placeholder');
    assert.equal(store.size, 0);
  });

  it('never caches a non-image answer such as a login page or a 401', async () => {
    const {cache, store} = memoryCache();
    const html = (async () =>
      new Response('<html>login</html>', {status: 200, headers: {'Content-Type': 'text/html'}})) as typeof fetch;
    const unauthorized = (async () => new Response('no', {status: 401})) as typeof fetch;
    for (const fetcher of [html, unauthorized]) {
      const res = await handleOdooImage(get('/img/odoo/product.template/3/image_1024'), {
        env: ENV,
        cache,
        fetcher,
      });
      assert.equal(res.headers.get('x-image-fallback'), 'placeholder');
    }
    assert.equal(store.size, 0);
  });

  it('sends Basic auth upstream only, never back to the browser', async () => {
    const seen: Seen[] = [];
    const res = await handleOdooImage(get('/img/odoo/product.template/3/image_1024'), {
      env: {...ENV, CATALOG_HTTP_USER: 'preview', CATALOG_HTTP_PASSWORD: 'pw'},
      fetcher: okFetcher(seen),
    });
    assert.match(seen[0].authorization ?? '', /^Basic /);
    for (const [, value] of res.headers) assert.ok(!value.includes('Basic'));
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    const head = await handleOdooImage(get('/img/odoo/product.template/3/image_1024', 'HEAD'), {
      env: ENV,
      fetcher: okFetcher(),
    });
    assert.equal(head.status, 200);
    assert.equal(head.body, null);
    const post = await handleOdooImage(get('/img/odoo/product.template/3/image_1024', 'POST'), {
      env: ENV,
      fetcher: okFetcher(),
    });
    assert.equal(post.status, 405);
  });

  it('keeps preview and production shops in separate cache entries', async () => {
    const {cache} = memoryCache();
    const path = '/img/odoo/product.template/3/image_1024?unique=ce9c438';
    await handleOdooImage(get(path), {env: {PUBLIC_SHOP_URL: 'https://staging.test'}, cache, fetcher: okFetcher()});
    const res = await handleOdooImage(get(path), {env: ENV, cache, fetcher: downFetcher});
    assert.equal(res.headers.get('x-image-fallback'), 'placeholder');
  });
});

describe('warmOdooImages', () => {
  it('fetches every uncached catalog image once so a later outage is covered', async () => {
    const {cache} = memoryCache();
    const seen: Seen[] = [];
    const catalog = {
      products: [
        {
          images: [
            'https://shop.test/web/image/product.template/3/image_1024?unique=a',
            'https://shop.test/web/image/product.image/1/image_1024?unique=b',
          ],
          variants: [
            {image: 'https://shop.test/web/image/product.product/4/image_1024?unique=c'},
            {image: null},
          ],
        },
      ],
    };
    const urls = catalogImageUrls(catalog);
    assert.equal(urls.length, 3);

    assert.equal(await warmOdooImages(SITE, urls, {env: ENV, cache, fetcher: okFetcher(seen)}), 3);
    assert.equal(await warmOdooImages(SITE, urls, {env: ENV, cache, fetcher: okFetcher(seen)}), 0);
    assert.equal(seen.length, 3);

    const res = await handleOdooImage(get('/img/odoo/product.product/4/image_1024?unique=c'), {
      env: ENV,
      cache,
      fetcher: downFetcher,
    });
    assert.equal(res.headers.get('x-image-source'), 'cache');
  });
});
