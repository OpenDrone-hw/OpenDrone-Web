import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {handleVideoLink, LINKS_TTL_MS, resetVideoLinksMemo, safeTarget} from './video-links.ts';
import type {AppEnv} from './app-api.ts';

const ENV = {APP_API_URL: 'https://app.example', APP_ACCESS_CLIENT_ID: 'id', APP_ACCESS_CLIENT_SECRET: 'sec', APP_STOREFRONT_TOKEN: 'tok'} as unknown as AppEnv;
const get = (path: string, method = 'GET') => new Request(`https://shop.example${path}`, {method});
const answer = (links: Record<string, unknown>) =>
  (async () => new Response(JSON.stringify({ok: true, data: {links, version: 'v1'}}), {headers: {'content-type': 'application/json'}})) as unknown as typeof fetch;
const T = '/products/x?utm_source=youtube&utm_medium=video&utm_campaign=film';

function memoryCache(): Cache {
  const m = new Map<string, Response>();
  return {async match(r: Request) { return m.get(r.url)?.clone(); }, async put(r: Request, res: Response) { m.set(r.url, res); }} as unknown as Cache;
}

describe('video short links', () => {
  beforeEach(resetVideoLinksMemo);

  it('redirects a known slug with 302 to the target', async () => {
    const res = (await handleVideoLink(get('/v/film-1'), ENV, null, answer({'film-1': T}), 0))!;
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `https://shop.example${T}`);
  });

  it('leaves an unknown slug, other paths and other methods to the normal 404', async () => {
    const f = answer({a: '/'});
    assert.equal(await handleVideoLink(get('/v/nope'), ENV, null, f, 0), null);
    assert.equal(await handleVideoLink(get('/v/constructor'), ENV, null, f, 0), null);
    assert.equal(await handleVideoLink(get('/v/a/b'), ENV, null, f, 0), null);
    assert.equal(await handleVideoLink(get('/vx/a'), ENV, null, f, 0), null);
    assert.equal(await handleVideoLink(get('/v/a', 'POST'), ENV, null, f, 0), null);
  });

  it('is off without APP_API_URL and never calls the app', async () => {
    const f = (async () => { throw new Error('no call'); }) as unknown as typeof fetch;
    assert.equal(await handleVideoLink(get('/v/a'), {} as AppEnv, null, f, 0), null);
  });

  it('never redirects off the site', async () => {
    for (const bad of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', 'evil', '/a\nb', '', 5]) {
      assert.equal(safeTarget(bad), null, String(bad));
      resetVideoLinksMemo();
      assert.equal(await handleVideoLink(get('/v/a'), ENV, null, answer({a: bad}), 0), null);
    }
    assert.equal(safeTarget('/?utm_source=x'), '/?utm_source=x');
  });

  it('holds the table for the TTL, then asks again', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ok: true, data: {links: {a: '/'}, version: 'v' + calls}}), {headers: {'content-type': 'application/json'}}); }) as unknown as typeof fetch;
    await handleVideoLink(get('/v/a'), ENV, null, f, 0);
    await handleVideoLink(get('/v/a'), ENV, null, f, LINKS_TTL_MS - 1);
    assert.equal(calls, 1);
    await handleVideoLink(get('/v/a'), ENV, null, f, LINKS_TTL_MS + 1);
    assert.equal(calls, 2);
  });

  it('keeps redirecting a known link while the app is down', async () => {
    const down = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const cache = memoryCache();
    await handleVideoLink(get('/v/a'), ENV, cache, answer({a: '/x'}), 0);
    // new isolate (no memo): the edge copy answers
    resetVideoLinksMemo();
    assert.equal((await handleVideoLink(get('/v/a'), ENV, cache, down, 10 * LINKS_TTL_MS))!.status, 302);
    // same isolate, no edge copy: the memory copy answers
    resetVideoLinksMemo();
    await handleVideoLink(get('/v/a'), ENV, null, answer({a: '/x'}), 0);
    assert.equal((await handleVideoLink(get('/v/a'), ENV, null, down, 10 * LINKS_TTL_MS))!.status, 302);
    // nothing known and the app down: 404
    resetVideoLinksMemo();
    assert.equal(await handleVideoLink(get('/v/a'), ENV, null, down, 0), null);
  });
});
