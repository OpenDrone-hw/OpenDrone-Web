import type {Route} from './+types/[sitemap.xml]';

/**
 * One sitemap for the whole site: the static routes plus a
 * `/products/<handle>` line per catalog product.
 *
 * It used to be a Hydrogen sitemap index over Shopify-hosted resources
 * with paginated child sitemaps. The site is a few dozen URLs, and a
 * single file is simpler for crawlers and for us.
 *
 * Redirect-only routes (/contribute, /incutec, /contact, /releases, /blog,
 * /terms and the un-prefixed legal slugs) and robots-disallowed ones
 * (/account, /api, /support) stay out. Legal pages are served per locale,
 * so each locale variant is listed; the pages themselves carry the
 * hreflang alternates.
 */
const STATIC_PATHS = [
  '/',
  '/products',
  '/open-source',
  '/production',
  '/roadmap',
  '/timeline',
  '/firmware-partners',
  '/newsletter',
];

const LEGAL_SLUGS = [
  'legal',
  'privacy',
  'algemene-voorwaarden',
  'herroepingsrecht',
  'shipping',
  'warranty',
  'security',
  'cookies',
  'end-use',
];

const LOCALES = ['en', 'nl', 'fr'];

export async function loader({request, context}: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;
  // A catalog failure must not empty the sitemap of the rest of the site.
  const catalog = await context.catalog.get().catch(() => null);
  const productPaths = (catalog?.products ?? []).map(
    (p) => `/products/${p.handle}`,
  );

  const paths = [
    ...STATIC_PATHS,
    ...productPaths,
    ...LOCALES.flatMap((l) => LEGAL_SLUGS.map((s) => `/${l}/${s}`)),
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((p) => `  <url><loc>${origin}${p}</loc></url>`).join('\n')}
</urlset>
`;

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': `max-age=${60 * 60 * 24}`,
    },
  });
}
