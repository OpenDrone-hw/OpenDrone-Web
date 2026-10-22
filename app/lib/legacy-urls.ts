/**
 * Every URL the Shopify-hosted storefront used to answer, and where it goes now. One pure resolver, called by the
 * route files (`collections.$`, `pages.$`, `policies.*`, `blogs.*`, `blog.*`, `search`, `discount.$`, the catch-all),
 * so the routes and `app/lib/legacy-urls.test.ts` (which walks `docs/url-inventory.json`) cannot disagree.
 *
 * Plain TypeScript with relative imports only: the node:test suites load it without the bundler.
 *
 * Mode: the shapes below are the same in Shopify mode and in app mode (COMMERCE_SOURCE=app), and every target is a
 * route of this site that both modes serve, so one table serves both. Only `/cart` differs (the app has its own cart
 * page) and stays in `cart.$.tsx`.
 */

export type LegacyRedirect = {status: 301 | 308; to: string};

/** `family` keys of `content/products/<handle>.json`, the values the listing's `type` filter reads. */
const COLLECTION_FAMILY: Record<string, string> = {
  fc: 'Flight Controller',
  'flight-controller': 'Flight Controller',
  'flight-controllers': 'Flight Controller',
  esc: '4-in-1 ESC',
  escs: '4-in-1 ESC',
  '4-in-1-esc': '4-in-1 ESC',
  '4-in-1-escs': '4-in-1 ESC',
  rx: 'ELRS Receiver',
  receiver: 'ELRS Receiver',
  receivers: 'ELRS Receiver',
  'elrs-receiver': 'ELRS Receiver',
  'elrs-receivers': 'ELRS Receiver',
  frame: 'Carbon Frame',
  frames: 'Carbon Frame',
  'carbon-frame': 'Carbon Frame',
  'carbon-frames': 'Carbon Frame',
  motor: 'Motors',
  motors: 'Motors',
};

/** Shopify-hosted policy pages: the storefront owns the legal copy under its own routes. */
const POLICY_TARGET: Record<string, string> = {
  'privacy-policy': '/privacy',
  'terms-of-service': '/algemene-voorwaarden',
  'terms-of-sale': '/algemene-voorwaarden',
  'refund-policy': '/herroepingsrecht',
  'shipping-policy': '/shipping',
  'subscription-policy': '/algemene-voorwaarden',
};

/** Shopify CMS pages that had a counterpart here. Any other `/pages/<handle>` is a 404: nothing linked to one. */
const PAGE_TARGET: Record<string, string> = {
  contact: '/contact',
  'contact-us': '/contact',
  shipping: '/shipping',
  'shipping-policy': '/shipping',
  'privacy-policy': '/privacy',
  privacy: '/privacy',
  'terms-of-service': '/algemene-voorwaarden',
  'terms-and-conditions': '/algemene-voorwaarden',
  'refund-policy': '/herroepingsrecht',
  returns: '/herroepingsrecht',
};

function segments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

/** `/collections/<handle>` to the listing filtered to that family, keeping a search term. */
export function collectionTarget(handle: string | undefined, search = ''): string {
  const term = new URLSearchParams(search).get('q')?.trim();
  const params = new URLSearchParams();
  const family = COLLECTION_FAMILY[(handle ?? '').trim().toLowerCase()];
  if (family) params.set('type', family);
  if (term) params.set('q', term);
  const query = params.toString();
  return query ? `/products?${query}` : '/products';
}

/**
 * The permanent redirect of an old Shopify path, or null when the path is not a legacy shape (the site's own
 * routes answer it, or nothing does). `search` is the query string with or without its `?`.
 */
export function legacyRedirect(pathname: string, search = ''): LegacyRedirect | null {
  const seg = segments(pathname);
  const first = seg[0]?.toLowerCase();
  const query = search && !search.startsWith('?') ? `?${search}` : search;

  switch (first) {
    case 'collections': {
      // /collections/<c>/products/<handle>: the product as seen inside a collection. The query (?variant=) rides along.
      if (seg[2]?.toLowerCase() === 'products' && seg[3]) {
        return {status: 301, to: `/products/${encodeURIComponent(seg[3])}${query}`};
      }
      return {status: 301, to: collectionTarget(seg[1], query)};
    }
    case 'search':
      if (seg.length === 1) {
        const term = new URLSearchParams(query).get('q');
        return {status: 301, to: term ? `/products?q=${encodeURIComponent(term)}` : '/products'};
      }
      return null;
    case 'discount':
      return {status: 301, to: '/products'};
    case 'blogs':
    case 'blog': {
      // /blogs/news.atom is the Shopify feed of the blog.
      if (seg[1]?.toLowerCase().endsWith('.atom') && seg.length === 2) return {status: 301, to: '/newsletter.rss'};
      const article = first === 'blogs' ? seg[2] : seg[1];
      // /blogs/<blog>/tagged/<tag> is a listing, not an article.
      if (article && article.toLowerCase() !== 'tagged') return {status: 301, to: `/newsletter/${encodeURIComponent(article)}`};
      return {status: 301, to: '/newsletter'};
    }
    case 'policies': {
      const target = seg[1] ? POLICY_TARGET[seg[1]] : undefined;
      return {status: 308, to: target ?? '/legal'};
    }
    case 'pages': {
      const target = seg[1] ? PAGE_TARGET[seg[1].toLowerCase()] : undefined;
      return target ? {status: 301, to: target} : null;
    }
    default:
      // Shopify's child sitemaps: sitemap_products_1.xml and its siblings. The one sitemap lists them all.
      if (seg.length === 1 && /^sitemap_[a-z_]+_\d+\.xml$/i.test(seg[0] ?? '')) return {status: 301, to: '/sitemap.xml'};
      return null;
  }
}

/** The numeric tail of a Shopify variant id: `gid://shopify/ProductVariant/123` and `123` both give `123`. */
export function variantKey(id: string | null | undefined): string {
  return (id ?? '').trim().split('/').pop() ?? '';
}

/** `alias`: the Shopify id a promoted variant came from (the app's canonical `merchandise_id` replaces it). */
type VariantLike = {merchandise_id?: string; alias?: string; options?: Record<string, string>};

/**
 * `/products/<handle>?variant=<id>`: the old Shopify way to open a product with one variant chosen. This site picks a
 * variant by option name (`?Model=5%22`), so the id becomes its options. An unknown or foreign id drops the
 * parameter. Returns the URL to redirect to, or null when there is no `variant` parameter.
 */
export function variantRedirect(pathname: string, search: string, variants: readonly VariantLike[]): string | null {
  const params = new URLSearchParams(search);
  if (!params.has('variant')) return null;
  const wanted = variantKey(params.get('variant'));
  params.delete('variant');
  const hit = wanted ? variants.find((v) => variantKey(v.merchandise_id) === wanted || variantKey(v.alias) === wanted) : undefined;
  // A single-variant product has the option `Title: Default Title`; it names nothing worth putting in a URL.
  const options = Object.entries(hit?.options ?? {}).filter(([name, value]) => !(name === 'Title' && value === 'Default Title'));
  for (const [name, value] of options) params.set(name, value);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
