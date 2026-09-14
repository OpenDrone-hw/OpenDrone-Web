import type {Route} from './+types/[newsletter.rss]';
import {archivePosts, postHtml} from '~/lib/posts';

const FEED_LIMIT = 50;

/**
 * RSS 2.0 feed of newsletter posts.
 *
 * Pulled by feed readers and surfaced from /newsletter via the
 * <link rel="alternate"> auto-discovery tag in the route's meta.
 *
 * Cache-Control: 10 min on the edge — we publish at most a few times
 * per month, so a stale-by-10-min feed is fine.
 */
export function loader({request}: Route.LoaderArgs) {
  const origin = new URL(request.url).origin;

  const articles = archivePosts()
    .slice(0, FEED_LIMIT)
    .map((p) => ({
      handle: p.handle,
      title: p.title,
      publishedAt: p.publishedAt,
      excerpt: p.excerpt,
      contentHtml: postHtml(p),
    }));

  const xml = renderFeed({origin, articles});

  return new Response(xml, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=600, s-maxage=600',
    },
  });
}

function renderFeed({
  origin,
  articles,
}: {
  origin: string;
  articles: Array<{
    handle: string;
    title: string;
    publishedAt: string;
    excerpt: string | null;
    contentHtml: string | null;
  }>;
}): string {
  const lastBuild = articles[0]?.publishedAt
    ? new Date(articles[0].publishedAt).toUTCString()
    : new Date().toUTCString();
  const items = articles
    .map((a) => {
      const link = `${origin}/newsletter/${a.handle}`;
      const pubDate = new Date(a.publishedAt).toUTCString();
      const description = a.excerpt
        ? esc(a.excerpt)
        : a.contentHtml
          ? esc(stripHtml(a.contentHtml).slice(0, 320))
          : '';
      return `    <item>
      <title>${esc(a.title)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>OpenDrone · Newsletter</title>
    <link>${esc(origin)}/newsletter</link>
    <atom:link href="${esc(origin)}/newsletter.rss" rel="self" type="application/rss+xml" />
    <description>Engineering notes, hardware releases, and write-ups from OpenDrone.</description>
    <language>en</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
${items}
  </channel>
</rss>`;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}


