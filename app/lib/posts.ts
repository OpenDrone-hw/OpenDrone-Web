/**
 * The newsletter archive, read from the Shopify blog `news`.
 *
 * Posts are written in Shopify admin (Content, Blog posts). A published
 * article shows at /newsletter/<handle> and in /newsletter.rss; a hidden
 * one does not exist on the site. The tag `no-archive` keeps a published
 * post out of the list, feed and sitemap while its page still resolves.
 *
 * Read through the Storefront API, which returns published articles only.
 * A Storefront failure renders an empty archive and a 404 for a post page
 * rather than an error page.
 */

import {storefrontRequest} from './shopify-storefront.ts';

export const BLOG_HANDLE = 'news';

export type Post = {
  /** URL slug, the Shopify article handle. */
  handle: string;
  title: string;
  /** ISO publication date. */
  publishedAt: string;
  /** The Shopify excerpt (plain text): the list deck and feed description. */
  excerpt: string | null;
  tags: string[];
  author: string | null;
  image: {url: string; altText: string | null} | null;
  /** The article body as Shopify stores it, HTML. */
  contentHtml: string;
};

type ArticleWire = {
  handle: string;
  title: string;
  publishedAt: string;
  excerpt: string | null;
  tags: string[];
  authorV2: {name: string} | null;
  image: {url: string; altText: string | null} | null;
  contentHtml: string;
};

type PostsEnv = Parameters<typeof storefrontRequest>[0];

export const POSTS_QUERY = `#graphql
  query OpenDronePosts($blog: String!, $first: Int!) {
    blog(handle: $blog) {
      articles(first: $first, sortKey: PUBLISHED_AT, reverse: true) {
        nodes {
          handle title publishedAt excerpt tags contentHtml
          authorV2 { name }
          image { url altText }
        }
      }
    }
  }
`;

export function mapArticle(a: ArticleWire): Post {
  return {
    handle: a.handle,
    title: a.title,
    publishedAt: a.publishedAt,
    excerpt: a.excerpt?.trim() || null,
    tags: a.tags,
    author: a.authorV2?.name ?? null,
    image: a.image,
    contentHtml: a.contentHtml,
  };
}

/** Every published post, newest first. Empty when Shopify is unreachable. */
export async function fetchPosts(env: PostsEnv, fetcher: typeof fetch = fetch): Promise<Post[]> {
  try {
    const data = await storefrontRequest<{blog: {articles: {nodes: ArticleWire[]}} | null}>(
      env,
      POSTS_QUERY,
      {blog: BLOG_HANDLE, first: 100},
      fetcher,
    );
    return (data.blog?.articles.nodes ?? []).map(mapArticle);
  } catch (error) {
    console.error('[posts] Shopify blog unavailable', error instanceof Error ? error.message : error);
    return [];
  }
}

/** The archive list, the feed and the sitemap: published, not `no-archive`. */
export function archiveOf(posts: Post[]): Post[] {
  return posts.filter((p) => !p.tags.includes('no-archive'));
}

export async function archivePosts(env: PostsEnv, fetcher: typeof fetch = fetch): Promise<Post[]> {
  return archiveOf(await fetchPosts(env, fetcher));
}
