import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {describe, it} from 'node:test';
import {
  AppUnavailable,
  appCommerceEnabled,
  appOp,
  cleanLines,
  readCart,
  requireAppCommerce,
  snapshot,
  writeCart,
  type AppEnv,
} from './app-api.ts';

const ENV: AppEnv = {
  COMMERCE_SOURCE: 'app',
  APP_API_URL: 'https://app.example/',
  APP_ACCESS_CLIENT_ID: 'cid',
  APP_ACCESS_CLIENT_SECRET: 'csecret',
  APP_STOREFRONT_TOKEN: 'bearer',
  APP_PROJECT: 'proj',
  SESSION_SECRET: 'test-secret',
};

describe('app commerce source', () => {
  it('is off unless COMMERCE_SOURCE is exactly app, and neither deploy config turns it on', () => {
    assert.equal(appCommerceEnabled({}), false);
    assert.equal(appCommerceEnabled({COMMERCE_SOURCE: 'App', APP_API_URL: 'x'}), false);
    assert.equal(appCommerceEnabled({COMMERCE_SOURCE: 'app'}), false);
    assert.equal(appCommerceEnabled(ENV), true);
    assert.throws(() => requireAppCommerce({}), (r: unknown) => r instanceof Response && r.status === 404);
    // Every wrangler file, the test shop's included: the app source is passed at deploy time, never written.
    const files = readdirSync(new URL('../../../', import.meta.url)).filter((f) => /^wrangler.*\.toml$/.test(f));
    assert.ok(files.includes('wrangler.toml') && files.includes('wrangler.production.toml') && files.includes('wrangler.shoptest.toml'));
    for (const file of files) {
      const toml = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(toml, /COMMERCE_SOURCE|APP_API_URL|APP_STOREFRONT_TOKEN|APP_PROJECT|APP_ACCESS|TEST_BANNER/, file);
    }
    const shoptest = readFileSync(new URL('../../../wrangler.shoptest.toml', import.meta.url), 'utf8');
    assert.doesNotMatch(shoptest, /^\s*(routes?|\[\[d1_databases|\[\[services|\[triggers)/m);
  });

  it('calls one app operation with the Access service token, the bearer and the project', async () => {
    const seen: Array<{url: string; init: RequestInit}> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({url, init});
      return new Response(JSON.stringify({ok: true, data: {x: 1}}), {headers: {'content-type': 'application/json'}});
    }) as unknown as typeof fetch;
    const out = await appOp<{x: number}>(ENV, 'storefront.quote', {country: 'BE'}, fetcher);
    assert.deepEqual(out, {ok: true, data: {x: 1}});
    assert.equal(seen[0].url, 'https://app.example/api/ops/storefront.quote');
    const h = seen[0].init.headers as Record<string, string>;
    assert.equal(h['CF-Access-Client-Id'], 'cid');
    assert.equal(h['CF-Access-Client-Secret'], 'csecret');
    assert.equal(h.authorization, 'Bearer bearer');
    assert.equal(h['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), {project: 'proj', country: 'BE'});
    assert.ok(seen[0].init.signal instanceof AbortSignal, 'a stalled app must time out');
  });

  it('treats a login page or a network error as the app being unavailable', async () => {
    const html = (async () => new Response('<html>', {status: 302, headers: {'content-type': 'text/html'}})) as unknown as typeof fetch;
    await assert.rejects(appOp(ENV, 'storefront.catalog', {}, html), AppUnavailable);
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    await assert.rejects(appOp(ENV, 'storefront.catalog', {}, down), AppUnavailable);
  });

  it('serves the last snapshot when the app does not answer', async () => {
    const store = new Map<string, Response>();
    const cache = {
      put: async (k: Request, r: Response) => void store.set(k.url, r),
      match: async (k: Request) => store.get(k.url)?.clone(),
    } as unknown as Cache;
    const ok = (async () =>
      new Response(JSON.stringify({ok: true, data: {version: 'v1'}}), {headers: {'content-type': 'application/json'}})) as unknown as typeof fetch;
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    assert.deepEqual(await snapshot(ENV, 'storefront.catalog', cache, ok), {version: 'v1'});
    assert.deepEqual(await snapshot(ENV, 'storefront.catalog', cache, down), {version: 'v1'});
    await assert.rejects(snapshot(ENV, 'storefront.posts', cache, down), AppUnavailable);
  });

  it('keeps the cart as signed, bounded lines', async () => {
    assert.deepEqual(cleanLines([{variant: 'a', qty: 2}, {variant: 'a', qty: 30}, {variant: 'b', qty: 1.5}, {qty: 1}, 'x']), [
      {variant: 'a', qty: 20},
    ]);
    assert.deepEqual(cleanLines([{variant: 'a', qty: 1}, {variant: 'a', qty: -1}]), []);
    const cookie = (await writeCart([{variant: 'v1', qty: 2}], ENV)).split(';', 1)[0];
    assert.deepEqual(await readCart(new Request('https://s/shop', {headers: {Cookie: cookie}}), ENV), [{variant: 'v1', qty: 2}]);
    const forged = cookie.replace(/=.*/, `=${encodeURIComponent(btoa(JSON.stringify([{variant: 'v1', qty: 9}])))}`);
    assert.deepEqual(await readCart(new Request('https://s/shop', {headers: {Cookie: forged}}), ENV), []);
  });
});
