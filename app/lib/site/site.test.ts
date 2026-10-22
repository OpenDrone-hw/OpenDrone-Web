import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {defaultSite, navHref, navLinks, plausibleScript, themeOverrides, type NavItem} from './config.ts';
import {renderPageMarkdown} from './markdown.ts';
import {resolvePage, resolveSite, type SiteEnv} from './resolve.ts';
import {framing, installPreviewBridge, previewOrigin} from './preview-bridge.ts';

const ENV: SiteEnv = {SITE_SOURCE: 'app', APP_API_URL: 'https://app.example/', APP_ACCESS_CLIENT_ID: 'cid', APP_ACCESS_CLIENT_SECRET: 'cs', APP_STOREFRONT_TOKEN: 'tok'};
const req = (host: string) => new Request(`https://${host}/x`);
const json = (body: unknown) => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
const ANSWER = {
  site: 'od', version: 3, name: 'Other', canonical: 'https://other.example',
  locales: ['nl-BE'], theme: {colours: {accent: '#ff0000', canvas: 'red;}'}},
  navigation: {header: [{label: 'Docs', kind: 'page', target: 'docs'}], footer: []},
  seo: {title_template: '%s - Other', description: 'About other', robots: 'noindex'},
  analytics: {plausible_domain: 'other.example'},
  pages: [{title: 'Docs', slug: 'docs', kind: 'page'}, {title: 'Home', slug: '', kind: 'home'}],
};

function memoryCache(): Cache {
  const m = new Map<string, Response>();
  return {
    match: async (r: Request) => m.get(r.url)?.clone(),
    put: async (r: Request, res: Response) => void m.set(r.url, res),
  } as unknown as Cache;
}

describe('resolveSite', () => {
  it('is the bundled default when SITE_SOURCE is off, and never calls the app', async () => {
    const f = async () => assert.fail('no call');
    for (const env of [{}, {SITE_SOURCE: 'app'}, {SITE_SOURCE: 'yes', APP_API_URL: 'https://a'}] as SiteEnv[]) {
      const s = await resolveSite(req('opendrone.be'), env, {fetcher: f as unknown as typeof fetch, cache: null});
      assert.deepEqual(s, defaultSite());
    }
    assert.equal(defaultSite().origin, 'https://opendrone.be');
  });

  it('reads the site of the host from the app with the service credentials and no project', async () => {
    let seen: {url: string; headers: Record<string, string>; body: string} | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = {url, headers: init.headers as Record<string, string>, body: String(init.body)};
      return json({ok: true, data: ANSWER});
    }) as unknown as typeof fetch;
    const s = await resolveSite(req('Other.Example'), ENV, {fetcher: f, cache: null});
    assert.equal(seen!.url, 'https://app.example/api/ops/storefront.site');
    assert.equal(seen!.body, '{"host":"other.example"}');
    assert.equal(seen!.headers.authorization, 'Bearer tok');
    assert.equal(seen!.headers['CF-Access-Client-Id'], 'cid');
    assert.equal(s?.fromApp, true);
    assert.equal(s?.name, 'Other');
    assert.equal(s?.titleTemplate, '%s - Other');
    assert.equal(s?.locale, 'nl_BE');
    assert.equal(s?.indexable, false);
    assert.equal(s?.plausibleDomain, 'other.example');
  });

  it('answers null for a host the app does not know', async () => {
    const f = (async () => json({ok: false, error: {code: 'not_found', detail: 'no site'}})) as unknown as typeof fetch;
    assert.equal(await resolveSite(req('nobody.example'), ENV, {fetcher: f, cache: null}), null);
  });

  it('falls back to the default when the app fails and nothing is cached', async () => {
    const down = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    assert.deepEqual(await resolveSite(req('other.example'), ENV, {fetcher: down, cache: null}), defaultSite());
    const html = (async () => new Response('<html>', {status: 502})) as unknown as typeof fetch;
    assert.deepEqual(await resolveSite(req('other.example'), ENV, {fetcher: html, cache: null}), defaultSite());
  });

  it('serves the cached site fresh, and stale when the app stops answering', async () => {
    const cache = memoryCache();
    let t = 0;
    let calls = 0;
    const ok = (async () => { calls++; return json({ok: true, data: ANSWER}); }) as unknown as typeof fetch;
    const down = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    await resolveSite(req('other.example'), ENV, {fetcher: ok, cache, now: () => t});
    await resolveSite(req('other.example'), ENV, {fetcher: ok, cache, now: () => (t = 30_000)});
    assert.equal(calls, 1);
    const stale = await resolveSite(req('other.example'), ENV, {fetcher: down, cache, now: () => (t = 600_000)});
    assert.equal(stale?.name, 'Other');
  });
});

describe('resolvePage', () => {
  const site = () => resolveSite(req('other.example'), ENV, {fetcher: (async () => json({ok: true, data: ANSWER})) as unknown as typeof fetch, cache: null});

  it('reads only a slug of the page index', async () => {
    const s = (await site())!;
    const calls: string[] = [];
    const f = (async (_u: string, init: RequestInit) => { calls.push(String(init.body)); return json({ok: true, data: {title: 'Docs', slug: 'docs', kind: 'page', body: '# Hi'}}); }) as unknown as typeof fetch;
    assert.equal((await resolvePage(s, 'other.example', 'docs', ENV, {fetcher: f, cache: null}))?.body, '# Hi');
    assert.deepEqual(calls, ['{"host":"other.example","slug":"docs"}']);
    assert.equal(await resolvePage(s, 'other.example', 'secret', ENV, {fetcher: f, cache: null}), null);
    assert.equal(await resolvePage(s, 'other.example', '', ENV, {fetcher: f, cache: null}), null);
    assert.equal(calls.length, 1);
  });

  it('is null for the bundled site and when the source is off', async () => {
    const f = (async () => assert.fail('no call')) as unknown as typeof fetch;
    assert.equal(await resolvePage(defaultSite(), 'opendrone.be', 'docs', ENV, {fetcher: f, cache: null}), null);
    assert.equal(await resolvePage((await site())!, 'other.example', 'docs', {}, {fetcher: f, cache: null}), null);
  });
});

describe('navigation, theme, analytics', () => {
  it('maps each kind to the route that exists', () => {
    const item = (kind: NavItem['kind'], target = ''): NavItem => ({label: 'x', kind, target});
    assert.equal(navHref(item('page', 'about')), '/about');
    assert.equal(navHref(item('posts')), '/newsletter');
    assert.equal(navHref(item('collection', 'flight-controllers')), '/collections/flight-controllers');
    assert.equal(navHref(item('product', 'od-1')), '/products/od-1');
    assert.equal(navHref(item('link', 'https://x.example/a')), 'https://x.example/a');
  });

  it('lists links, drops unsafe ones, and is null for an empty menu', () => {
    assert.equal(navLinks([], 'header'), null);
    const out = navLinks([{label: 'A', kind: 'link', target: 'javascript:alert(1)'}, {label: 'B', kind: 'page', target: 'b'}], 'footer');
    assert.deepEqual(out, [{id: 'site-footer-1', title: 'B', url: '/b'}]);
  });

  it('maps colours onto the --color-* tokens and drops anything that could leave the declaration', () => {
    assert.deepEqual(themeOverrides({accent: '#ff0000', canvas: 'red;}', text: 'rgb(1, 2, 3)'}), {'--color-accent': '#ff0000', '--color-text': 'rgb(1, 2, 3)'});
  });

  it('keeps the bundled Plausible script unless the site names a domain', () => {
    assert.match(plausibleScript({plausibleDomain: null}).src, /pa-/);
    assert.deepEqual(plausibleScript({plausibleDomain: 'other.example'}), {src: 'https://plausible.io/js/script.js', domain: 'other.example'});
  });
});

describe('page markdown', () => {
  it('renders Markdown, shows raw HTML as text and neutralises script links', () => {
    const html = renderPageMarkdown('# T\n\n<script>x()</script>\n\n[a](javascript:alert(1)) [b](/ok)');
    assert.match(html, /<h1>T<\/h1>/);
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /href="\/ok"/);
  });
});

describe('off by default', () => {
  it('no wrangler file sets SITE_SOURCE', () => {
    for (const f of ['wrangler.toml', 'wrangler.production.toml', 'wrangler.shoptest.toml', 'rangler.production.toml']) {
      assert.doesNotMatch(readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8'), /SITE_SOURCE/);
    }
  });
});

describe('site texts', () => {
  it('keeps string texts of the app answer, none for the default site', async () => {
    const f = (async () => json({ok: true, data: {...ANSWER, texts: {'home.hero_line1': 'Hi', 'home.bad': {en: 'x'}}}})) as unknown as typeof fetch;
    assert.deepEqual((await resolveSite(req('other.example'), ENV, {fetcher: f, cache: null}))?.texts, {'home.hero_line1': 'Hi'});
    assert.deepEqual(defaultSite().texts, {});
    assert.deepEqual((await resolveSite(req('opendrone.be'), {}, {cache: null}))?.texts, {});
  });
});

describe('preview bridge', () => {
  const ORIGIN = 'https://app.incutec.com';
  it('frames: nothing in production, same origin in dev, only the Studio on a preview Worker', () => {
    const csp = "default-src 'self'; frame-ancestors 'none'";
    assert.deepEqual(framing(csp, false, null), {csp, xfo: 'DENY'});
    assert.deepEqual(framing(csp, true, null), {csp: "default-src 'self'; frame-ancestors 'self'", xfo: 'SAMEORIGIN'});
    assert.deepEqual(framing(csp, false, ORIGIN), {csp: `default-src 'self'; frame-ancestors ${ORIGIN}`, xfo: null});
    // a STUDIO_ORIGIN without SITE_PREVIEW=1 never relaxes production
    assert.deepEqual(framing(csp, false, previewOrigin({STUDIO_ORIGIN: ORIGIN})), {csp, xfo: 'DENY'});
  });
  it('is on only with SITE_PREVIEW=1 and a usable STUDIO_ORIGIN', () => {
    assert.equal(previewOrigin({}), null);
    assert.equal(previewOrigin({STUDIO_ORIGIN: ORIGIN}), null);
    assert.equal(previewOrigin({SITE_PREVIEW: '1'}), null);
    assert.equal(previewOrigin({SITE_PREVIEW: '1', STUDIO_ORIGIN: 'http://evil.example'}), null);
    assert.equal(previewOrigin({SITE_PREVIEW: '1', STUDIO_ORIGIN: ORIGIN + '/x'}), ORIGIN);
  });

  function fake() {
    const sent: Array<[unknown, string]> = [];
    const doc: Record<string, (e: any) => void> = {};
    const win: Record<string, any> = {};
    const els = [{attrs: {'data-edit': 'home.a'}, textContent: 'old'}, {attrs: {'data-edit': 'home.b'}, textContent: 'keep'}].map((e) => ({...e, getAttribute: (n: string) => (e.attrs as Record<string, string>)[n] ?? null}));
    win.parent = {postMessage: (m: unknown, o: string) => sent.push([m, o])};
    win.document = {addEventListener: (t: string, f: any) => (doc[t] = f), removeEventListener: (t: string) => delete doc[t], querySelectorAll: () => els};
    const handlers: Record<string, (e: any) => void> = {};
    win.addEventListener = (t: string, f: any) => (handlers[t] = f);
    win.removeEventListener = (t: string) => delete handlers[t];
    return {win: win as any, sent, doc, handlers, els};
  }

  it('posts the clicked key to the studio origin only', () => {
    const t = fake();
    const off = installPreviewBridge(t.win, ORIGIN);
    let prevented = false;
    const target = {closest: () => t.els[0], getAttribute: () => null, textContent: ''};
    t.doc.click({target, preventDefault: () => (prevented = true)});
    assert.deepEqual(t.sent, [[{type: 'data-edit', key: 'home.a'}, ORIGIN]]);
    assert.equal(prevented, true);
    t.doc.click({target: {closest: () => null}, preventDefault: () => assert.fail('no')});
    assert.equal(t.sent.length, 1);
    off();
    assert.equal(t.doc.click, undefined);
  });

  it('sets text live from the studio origin only', () => {
    const t = fake();
    installPreviewBridge(t.win, ORIGIN);
    t.handlers.message({origin: 'https://evil.example', data: {type: 'data-edit-set', key: 'home.a', value: 'bad'}});
    assert.equal(t.els[0].textContent, 'old');
    t.handlers.message({origin: ORIGIN, data: {type: 'data-edit-set', key: 'home.a', value: 'new'}});
    assert.equal(t.els[0].textContent, 'new');
    assert.equal(t.els[1].textContent, 'keep');
    t.handlers.message({origin: ORIGIN, data: {type: 'other', key: 'home.b', value: 'x'}});
    assert.equal(t.els[1].textContent, 'keep');
  });

  it('does nothing outside a frame', () => {
    const t = fake();
    t.win.parent = t.win;
    installPreviewBridge(t.win, ORIGIN);
    assert.equal(t.doc.click, undefined);
  });
});
