// The list of public URLs to keep when the storefront leaves Shopify (docs/url-inventory.json).
//
// Public sources only:
//   1. the live sitemap, https://opendrone.be/sitemap.xml, and any child sitemap it names (GET only, one at a time,
//      a short pause between requests, a clear User-Agent);
//   2. the app catalog and posts, in the shape of the app's storefront.catalog and storefront.posts snapshots
//      (handles of products, variants, collections, articles). Default: the fixtures under test/fixtures/;
//   3. the Shopify-standard path shapes a link or a search engine may still hold.
//
// Usage: node scripts/url-inventory.mjs [--sitemap <url|file>] [--catalog <file>] [--posts <file>] [--out <file>] [--check]
//   --sitemap  default https://opendrone.be/sitemap.xml; a file path reads that file instead (no network)
//   --check    do not write; exit 1 when the committed file differs (for CI or a release gate)
// The output is sorted and carries no date, so a rerun with unchanged sources changes nothing.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const SITEMAP = opt('sitemap', 'https://opendrone.be/sitemap.xml');
const CATALOG = opt('catalog', `${root}test/fixtures/app-catalog.json`);
const POSTS = opt('posts', `${root}test/fixtures/app-posts.json`);
const OUT = opt('out', `${root}docs/url-inventory.json`);
const UA = 'OpenDrone-url-inventory/1 (read-only GET crawl for the Shopify cutover; opendrone.be)';
const PAUSE_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function read(source) {
  if (!/^https?:\/\//.test(source)) return readFileSync(source, 'utf8');
  const res = await fetch(source, {method: 'GET', headers: {'user-agent': UA}});
  if (!res.ok) throw new Error(`${source}: HTTP ${res.status}`);
  const body = await res.text();
  await sleep(PAUSE_MS);
  return body;
}

const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

/** Every page URL of a sitemap or sitemap index, children followed (depth 2). */
async function sitemapPaths(source, depth = 0) {
  const xml = await read(source);
  const out = [];
  for (const loc of locs(xml)) {
    if (/<sitemapindex/.test(xml) && depth < 2) out.push(...(await sitemapPaths(loc, depth + 1)));
    else {
      const u = new URL(loc);
      out.push(u.pathname + u.search);
    }
  }
  return out;
}

const entries = new Map();
const add = (path, source, kind) => {
  if (!entries.has(path)) entries.set(path, {path, source, kind});
};

// 1. The sitemap.
for (const path of await sitemapPaths(SITEMAP)) {
  const kind = path.startsWith('/products/') ? 'product' : path.startsWith('/newsletter/') ? 'article' : 'page';
  add(path, 'sitemap', kind);
}
add('/sitemap.xml', 'standard', 'sitemap');
add('/robots.txt', 'standard', 'robots');
add('/products.json', 'standard', 'feed');
add('/newsletter.rss', 'standard', 'feed');

// 2. The app snapshots.
const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const posts = JSON.parse(readFileSync(POSTS, 'utf8'));
const collections = ['all', ...(catalog.collections ?? []).map((c) => c.handle)].filter((h, i, a) => h && a.indexOf(h) === i);
for (const p of catalog.products ?? []) {
  const base = `/products/${p.handle}`;
  add(base, 'app catalog', 'product');
  for (const v of p.variants ?? []) {
    const key = String(v.id ?? '').split('/').pop();
    if (key) add(`${base}?variant=${key}`, 'app catalog', 'product-variant');
  }
  if (collections[1]) add(`/collections/${collections[1]}/products/${p.handle}`, 'app catalog', 'collection-product');
}
for (const c of collections) add(`/collections/${c}`, 'app catalog', 'collection');
for (const a of posts.posts ?? []) {
  add(`/newsletter/${a.handle}`, 'app posts', 'article');
  add(`/blogs/news/${a.handle}`, 'app posts', 'blog-article');
}

// 3. Shopify-standard shapes.
const standard = [
  ['/collections', 'collection'],
  ['/collections/all?q=frame', 'collection'],
  ['/blogs', 'blog'],
  ['/blogs/news', 'blog'],
  ['/blogs/news.atom', 'blog'],
  ['/blogs/news/tagged/release', 'blog'],
  ['/blog', 'blog'],
  ['/pages/contact', 'page'],
  ['/pages/shipping-policy', 'page'],
  ['/pages/about-us', 'page'],
  ['/policies', 'policy'],
  ['/policies/privacy-policy', 'policy'],
  ['/policies/terms-of-service', 'policy'],
  ['/policies/refund-policy', 'policy'],
  ['/policies/shipping-policy', 'policy'],
  ['/policies/contact-information', 'policy'],
  ['/cart', 'cart'],
  ['/account', 'account'],
  ['/account/login', 'account'],
  ['/account/register', 'account'],
  ['/account/orders', 'account'],
  ['/account/addresses', 'account'],
  ['/search', 'search'],
  ['/search?q=openfc', 'search'],
  ['/discount/WELCOME10', 'discount'],
  ['/sitemap_products_1.xml', 'sitemap'],
  ['/sitemap_pages_1.xml', 'sitemap'],
  ['/sitemap_collections_1.xml', 'sitemap'],
  ['/sitemap_blogs_1.xml', 'sitemap'],
];
for (const [path, kind] of standard) add(path, 'shopify standard', kind);
const firstVariant = catalog.products?.find((p) => p.variants?.length);
if (firstVariant) {
  const key = String(firstVariant.variants[0].id).split('/').pop();
  add(`/cart/${key}:1`, 'shopify standard', 'cart');
}

const list = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
const json = `${JSON.stringify({note: 'Generated by scripts/url-inventory.mjs from public sources; do not edit by hand.', urls: list}, null, 2)}\n`;

if (args.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    /* missing counts as different */
  }
  if (current !== json) {
    console.error(`${OUT} is out of date: run node scripts/url-inventory.mjs`);
    process.exit(1);
  }
} else {
  writeFileSync(OUT, json);
}
console.log(`${list.length} URLs`);
