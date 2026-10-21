import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {collectionTarget, legacyRedirect, variantRedirect} from './legacy-urls.ts';
import {LEGAL_SLUGS} from './legal-slugs.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/legacy-urls.test.ts

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
type InventoryUrl = {path: string; source: string; kind: string};
const inventory = (JSON.parse(read('../../docs/url-inventory.json')) as {urls: InventoryUrl[]}).urls;
const catalog = JSON.parse(read('../../test/fixtures/app-catalog.json')) as {
  products: Array<{handle: string; variants: Array<{id: string; options: Record<string, string>}>}>;
};
const posts = new Set((JSON.parse(read('../../test/fixtures/app-posts.json')) as {posts: Array<{handle: string}>}).posts.map((p) => p.handle));
const products = new Map(catalog.products.map((p) => [p.handle, p]));

/** The site's own routes as patterns, from the flat-route file names of app/routes plus the locale legal routes. */
function routePatterns(): RegExp[] {
  const out: RegExp[] = [];
  for (const file of readdirSync(new URL('../routes/', import.meta.url))) {
    if (!/\.tsx?$/.test(file)) continue;
    const name = file.replace(/\.tsx?$/, '');
    if (name === '$') continue; // the catch-all answers 404 for what no route knows
    // Routes that only redirect through the legacy table are not live pages: the table has to cover them.
    if (/^(collections|pages|policies|blogs|blog|search|discount)(\.|$)/.test(name)) continue;
    const tokens = name.match(/\[[^\]]+\]|[^.]+/g) ?? [];
    let re = '';
    for (const raw of tokens) {
      if (raw === '_index') continue;
      if (raw.startsWith('_')) continue; // pathless layout
      if (raw === '$') re += '(?:/.*)?';
      else if (raw.startsWith('$')) re += '/[^/]+';
      else if (raw.startsWith('[')) re += `/${raw.slice(1, -1).replace(/[.*+?^${}()|\\]/g, '\\$&')}`;
      else re += `/${raw.replace(/_$/, '').replace(/[.*+?^${}()|\\]/g, '\\$&')}`;
    }
    out.push(new RegExp(`^${re || '/'}$`));
  }
  for (const slug of LEGAL_SLUGS) for (const l of ['en', 'nl', 'fr']) out.push(new RegExp(`^/${l}/${slug}$`));
  return out;
}
const ROUTES = routePatterns();
const isRoute = (path: string) => ROUTES.some((r) => r.test(path));

/** Inventory paths that have no target on purpose: nothing ever linked to them, so a 404 is right. Say why. */
const NO_TARGET = new Map([['/pages/about-us', 'no Shopify page of that name existed here; nothing links to it']]);

/** One resolution step as a request would take it: the legacy table, then the product route's variant rule. */
function hop(path: string): string | null {
  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  const search = q < 0 ? '' : path.slice(q);
  const legacy = legacyRedirect(pathname, search);
  if (legacy) return legacy.to;
  const product = pathname.startsWith('/products/') ? products.get(pathname.slice('/products/'.length)) : undefined;
  return product ? variantRedirect(pathname, search, product.variants.map((v) => ({merchandise_id: v.id, options: v.options}))) : null;
}

/** Live: a route of the site answers the path itself (a product or article only when its handle exists). */
function isLive(path: string): boolean {
  const pathname = path.split('?')[0] ?? path;
  if (pathname.startsWith('/products/')) return products.has(pathname.slice('/products/'.length));
  if (pathname.startsWith('/newsletter/')) return posts.has(pathname.slice('/newsletter/'.length));
  return isRoute(pathname);
}

describe('url inventory', () => {
  it('holds the sitemap, the app handles and the Shopify shapes', () => {
    const kinds = new Set(inventory.map((u) => u.kind));
    for (const kind of ['product', 'product-variant', 'collection', 'collection-product', 'article', 'blog-article', 'policy', 'cart', 'account', 'search', 'sitemap', 'robots']) {
      assert.ok(kinds.has(kind), `no ${kind} URL in the inventory`);
    }
    assert.equal(new Set(inventory.map((u) => u.path)).size, inventory.length, 'a path is listed twice');
    assert.ok(inventory.every((u) => u.path.startsWith('/')), 'inventory holds paths, not hosts');
  });

  it('leaves no URL without a target: live, or one redirect to a live page', () => {
    const lost: string[] = [];
    let redirected = 0;
    for (const {path} of inventory) {
      const first = hop(path);
      if (first === null) {
        if (!isLive(path) && !NO_TARGET.has(path)) lost.push(`${path}: no route and no redirect`);
        continue;
      }
      redirected++;
      if (!isLive(first)) lost.push(`${path} -> ${first}: the target is not a page`);
      else if (hop(first) !== null) lost.push(`${path} -> ${first}: more than one hop`);
    }
    assert.deepEqual(lost, []);
    assert.ok(redirected > 50, 'the inventory exercises the redirects');
  });

  it('keeps the allowed gaps honest', () => {
    for (const path of NO_TARGET.keys()) {
      assert.ok(inventory.some((u) => u.path === path), `${path} is not in the inventory`);
      assert.equal(hop(path), null);
      assert.equal(isLive(path), false);
    }
  });
});

describe('legacyRedirect', () => {
  it('sends a product inside a collection to the product and keeps the variant', () => {
    assert.deepEqual(legacyRedirect('/collections/frames/products/openframe', '?variant=1001'), {status: 301, to: '/products/openframe?variant=1001'});
    assert.deepEqual(legacyRedirect('/collections/all/products/openrx', ''), {status: 301, to: '/products/openrx'});
  });

  it('sends a collection to the listing, filtered to its family when it has one', () => {
    assert.equal(collectionTarget('receivers'), '/products?type=ELRS+Receiver');
    assert.equal(collectionTarget('all'), '/products');
    assert.equal(legacyRedirect('/collections', '')?.to, '/products');
    assert.equal(legacyRedirect('/collections/frames', '?q=5%22')?.to, '/products?type=Carbon+Frame&q=5%22');
  });

  it('sends blogs, the feed and tag pages to the newsletter', () => {
    assert.equal(legacyRedirect('/blogs/news/launch', '')?.to, '/newsletter/launch');
    assert.equal(legacyRedirect('/blog/launch', '')?.to, '/newsletter/launch');
    assert.equal(legacyRedirect('/blogs/news', '')?.to, '/newsletter');
    assert.equal(legacyRedirect('/blogs/news/tagged/x', '')?.to, '/newsletter');
    assert.equal(legacyRedirect('/blogs/news.atom', '')?.to, '/newsletter.rss');
  });

  it('sends policies and pages to the legal routes, and any other page nowhere', () => {
    assert.deepEqual(legacyRedirect('/policies/refund-policy', ''), {status: 308, to: '/herroepingsrecht'});
    assert.equal(legacyRedirect('/policies/unknown', '')?.to, '/legal');
    assert.equal(legacyRedirect('/pages/contact', '')?.to, '/contact');
    assert.equal(legacyRedirect('/pages/anything-else', ''), null);
  });

  it('sends search, discount and child sitemaps', () => {
    assert.equal(legacyRedirect('/search', '?q=open fc')?.to, '/products?q=open%20fc');
    assert.equal(legacyRedirect('/discount/CODE', '')?.to, '/products');
    assert.equal(legacyRedirect('/sitemap_products_1.xml', '')?.to, '/sitemap.xml');
  });

  it('leaves the site\'s own paths alone', () => {
    for (const path of ['/', '/products', '/products/openrx', '/newsletter/x', '/shop/cart', '/en/privacy', '/sitemap.xml', '/searching']) {
      assert.equal(legacyRedirect(path, ''), null, path);
    }
  });
});

describe('variantRedirect', () => {
  const variants: Array<{merchandise_id: string; options: Record<string, string>}> = [
    {merchandise_id: 'gid://shopify/ProductVariant/11', options: {Model: '20×20'}},
    {merchandise_id: 'gid://shopify/ProductVariant/12', options: {Model: '30×30'}},
    {merchandise_id: 'gid://shopify/ProductVariant/13', options: {Title: 'Default Title'}},
  ];

  it('turns the id into the option parameters', () => {
    assert.equal(variantRedirect('/products/openesc', '?variant=12', variants), `/products/openesc?Model=${encodeURIComponent('30×30')}`);
  });

  it('keeps other parameters and lets the id win over a stale option', () => {
    assert.equal(
      variantRedirect('/products/openesc', '?utm_source=x&Model=20&variant=12', variants),
      `/products/openesc?utm_source=x&Model=${encodeURIComponent('30×30')}`,
    );
  });

  it('drops an unknown id and the default title', () => {
    assert.equal(variantRedirect('/products/openesc', '?variant=999', variants), '/products/openesc');
    assert.equal(variantRedirect('/products/strap', '?variant=13', variants), '/products/strap');
  });

  it('also finds a variant by its Shopify alias when the catalog uses canonical ids', () => {
    const owned = [
      {merchandise_id: 'variant:aaa-1', alias: 'gid://shopify/ProductVariant/21', options: {Model: '20×20'}},
      {merchandise_id: 'variant:bbb-2', alias: 'gid://shopify/ProductVariant/22', options: {Model: '30×30'}},
    ];
    assert.equal(variantRedirect('/products/openesc', '?variant=22', owned), `/products/openesc?Model=${encodeURIComponent('30×30')}`);
    assert.equal(variantRedirect('/products/openesc', '?variant=gid://shopify/ProductVariant/21', owned), `/products/openesc?Model=${encodeURIComponent('20×20')}`);
  });

  it('does nothing without a variant parameter', () => {
    assert.equal(variantRedirect('/products/openesc', '?Model=20', variants), null);
  });
});
