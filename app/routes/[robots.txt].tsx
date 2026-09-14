import type {Route} from './+types/[robots.txt]';

export function loader({request}: Route.LoaderArgs) {
  const url = new URL(request.url);
  const body = robotsTxtData({url: url.origin});

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',

      'Cache-Control': `max-age=${60 * 60 * 24}`,
    },
  });
}

function robotsTxtData({url}: {url?: string}) {
  const sitemapUrl = url ? `${url}/sitemap.xml` : undefined;

  return `
# AI assistants: agent guide at /llms.txt, catalog feed at /products.json
User-agent: *
${generalDisallowRules({sitemapUrl})}

# Google adsbot ignores robots.txt unless specifically named!
User-agent: adsbot-google
Disallow: /account
Disallow: /api/

User-agent: Nutch
Disallow: /

User-agent: AhrefsBot
Crawl-delay: 10
${generalDisallowRules({sitemapUrl})}

User-agent: AhrefsSiteAudit
Crawl-delay: 10
${generalDisallowRules({sitemapUrl})}

User-agent: MJ12bot
Crawl-Delay: 10

User-agent: Pinterest
Crawl-delay: 1
`.trim();
}

/**
 * Disallow rules for the routes that carry no indexable content: the
 * account redirects into the shop portal, the JSON APIs, and the support
 * desk (per-visitor ticket state). The cart, collections, Shopify blog
 * and policy rules are gone with those routes.
 */
function generalDisallowRules({sitemapUrl}: {sitemapUrl?: string}) {
  return `Disallow: /account
Disallow: /api/
Disallow: /support
Disallow: /support/
${sitemapUrl ? `Sitemap: ${sitemapUrl}` : ''}`;
}
