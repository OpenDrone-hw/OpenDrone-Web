import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {archivePosts, fetchPosts} from './posts.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/posts.test.ts

const env = {
  SHOPIFY_STORE_DOMAIN: 'example.myshopify.com',
  SHOPIFY_STOREFRONT_TOKEN: 'token',
  SHOPIFY_STOREFRONT_API_VERSION: '2026-07',
} as Parameters<typeof fetchPosts>[0];

const article = (handle: string, tags: string[] = []) => ({
  handle,
  title: `Title ${handle}`,
  publishedAt: '2026-10-02T10:00:00Z',
  excerpt: ' A deck. ',
  tags,
  contentHtml: '<p>Body</p>',
  authorV2: {name: 'Stan'},
  image: null,
});

function stub(body: unknown, status = 200): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body)) as {variables: {blog: string}};
    assert.equal(sent.variables.blog, 'news');
    return new Response(JSON.stringify(body), {status});
  }) as typeof fetch;
}

describe('fetchPosts', () => {
  it('maps the Shopify blog articles', async () => {
    const posts = await fetchPosts(env, stub({data: {blog: {articles: {nodes: [article('a')]}}}}));
    assert.deepEqual(posts, [
      {
        handle: 'a',
        title: 'Title a',
        publishedAt: '2026-10-02T10:00:00Z',
        excerpt: 'A deck.',
        tags: [],
        author: 'Stan',
        image: null,
        contentHtml: '<p>Body</p>',
      },
    ]);
  });

  it('returns no posts when Shopify fails or the blog is missing', async () => {
    assert.deepEqual(await fetchPosts(env, stub({}, 500)), []);
    assert.deepEqual(await fetchPosts(env, stub({data: {blog: null}})), []);
  });

  it('keeps no-archive posts out of the archive', async () => {
    const nodes = [article('a'), article('b', ['no-archive'])];
    const posts = await archivePosts(env, stub({data: {blog: {articles: {nodes}}}}));
    assert.deepEqual(posts.map((p) => p.handle), ['a']);
  });
});

describe('fetchPosts in app mode', () => {
  const appEnv = {...env, COMMERCE_SOURCE: 'app', APP_API_URL: 'https://app.example'} as unknown as Parameters<typeof fetchPosts>[0];
  const appPost = {
    handle: 'a',
    title: 'Title a',
    published_at: '2026-10-02T10:00:00Z',
    excerpt: ' A deck. ',
    tags: ['no-archive'],
    author: null,
    image: {url: 'https://files.example/a.png', alt: ''},
    content_html: '<p>Body</p>',
  };

  it('reads the app snapshot and never calls Shopify', async () => {
    const calls: string[] = [];
    const fetcher = (async (url: unknown) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ok: true, data: {posts: [appPost]}}), {headers: {'content-type': 'application/json'}});
    }) as typeof fetch;
    const posts = await fetchPosts(appEnv, fetcher);
    assert.deepEqual(calls, ['https://app.example/api/ops/storefront.posts']);
    assert.equal(posts[0]?.handle, 'a');
    assert.equal(posts[0]?.excerpt, 'A deck.');
    assert.deepEqual(posts[0]?.image, {url: 'https://files.example/a.png', altText: null});
    assert.deepEqual((await archivePosts(appEnv, fetcher)).map((p) => p.handle), []);
  });

  it('returns no posts when the app does not answer', async () => {
    const down = (async () => {
      throw new Error('down');
    }) as typeof fetch;
    assert.deepEqual(await fetchPosts(appEnv, down), []);
  });
});
