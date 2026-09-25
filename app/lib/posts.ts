/**
 * The newsletter archive, rendered from this repository.
 *
 * The posts were always authored here as `content/posts/<slug>.md`; they
 * used to be pushed into a Shopify blog and read back through the
 * Storefront API. The blog died with the store, so the Markdown is now
 * the only source: bundled at build time the way the legal pages are
 * (Vite's eager glob, because the Oxygen worker has no filesystem), with
 * the same front matter the publish script used to read.
 */

import {mdToHtml} from '~/lib/legal';
import {checkoutOpen} from '~/lib/shopify-cart-action';

/** The shop is open by the rule the chrome uses: both commerce gates. */
export const shopIsOpen = checkoutOpen;

export type Post = {
  /** URL slug, the file name without .md. */
  handle: string;
  title: string;
  /** ISO date from the front matter. */
  publishedAt: string;
  /** One or two sentences: the list deck and the email preview text. */
  excerpt: string | null;
  tags: string[];
  author: string | null;
  /** Hero image URL, resolved to a public path. */
  image: {url: string; altText: string | null} | null;
  /** The body, Markdown source. */
  body: string;
  /** `launch: true`: about the open shop, so it exists only once the shop
   *  is open (a closed production site must not announce preorders). */
  launch: boolean;
  /** `superseded_by: <slug>`: once the shop is open this post leaves the
   *  archive and feed, and its page points at the newer post. */
  supersededBy: string | null;
};

const FILES: Record<string, string> = import.meta.env
  ? import.meta.glob<string>('/content/posts/*.md', {
      eager: true,
      query: '?raw',
      import: 'default',
    })
  : {};

/** `/content/posts/openrx-range-test.md` -> `openrx-range-test` */
function handleOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1, -'.md'.length);
}

/**
 * Minimal YAML front matter: `key: value` lines, plus `[a, b]` lists.
 * The files are ours and the shape is fixed, so a full YAML parser would
 * be a dependency bought for nothing.
 */
function parseFrontMatter(src: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!src.startsWith('---')) return {meta: {}, body: src};
  const end = src.indexOf('\n---', 3);
  if (end === -1) return {meta: {}, body: src};
  const meta: Record<string, string> = {};
  for (const line of src.slice(3, end).split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const bodyStart = src.indexOf('\n', end + 1);
  return {meta, body: bodyStart === -1 ? '' : src.slice(bodyStart + 1)};
}

function parseTags(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

/**
 * Post images are authored beside the Markdown in `content/posts/images/`
 * and served from `public/posts/`, so a front-matter or in-body
 * `./images/x.jpg` resolves to `/posts/x.jpg`. Add a new image to both
 * places; the copies are byte-identical.
 */
function resolveImage(value: string | undefined): string | null {
  if (!value) return null;
  return rewriteImagePath(value);
}

function rewriteImagePath(value: string): string {
  if (value.startsWith('http')) return value;
  const name = value.split('/').pop();
  return name ? `/posts/${name}` : value;
}

function build(): Post[] {
  const out: Post[] = [];
  for (const [filePath, src] of Object.entries(FILES)) {
    const handle = handleOf(filePath);
    if (handle.startsWith('_')) continue;
    const {meta, body} = parseFrontMatter(src);
    // `published: false` is the draft state the template ships with.
    if (meta.published !== 'true') continue;
    if (!meta.title || !meta.date) continue;
    const image = resolveImage(meta.image);
    out.push({
      handle,
      title: meta.title.replace(/^["']|["']$/g, ''),
      publishedAt: `${meta.date}T00:00:00Z`,
      excerpt: meta.summary?.replace(/^["']|["']$/g, '') || null,
      tags: parseTags(meta.tags),
      author: meta.author || null,
      image: image ? {url: image, altText: null} : null,
      body,
      launch: meta.launch === 'true',
      supersededBy: meta.superseded_by || null,
    });
  }
  // Newest first, the order the archive and the feed both read in.
  out.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return out;
}

export const POSTS: Post[] = build();

/** Whether a post exists for a site whose shop is open or closed. */
function visible(p: Post, shopOpen: boolean): boolean {
  return shopOpen || !p.launch;
}

/** The archive list. `no-archive` keeps a post out of it (rare); launch
 *  posts appear only once the shop is open, and superseded posts leave it
 *  then. */
export function archivePosts(shopOpen = false): Post[] {
  return POSTS.filter(
    (p) =>
      !p.tags.includes('no-archive') &&
      visible(p, shopOpen) &&
      !(shopOpen && p.supersededBy),
  );
}

export function postByHandle(
  handle: string | undefined,
  shopOpen = false,
): Post | null {
  const post = POSTS.find((p) => p.handle === handle) ?? null;
  return post && visible(post, shopOpen) ? post : null;
}

/** The post body as HTML, using the same converter as the legal pages. */
export function postHtml(post: Post): string {
  // In-body `./images/x.jpg` points at the authoring folder; the served
  // copy is /posts/x.jpg.
  return mdToHtml(post.body.replace(/\.\/images\//g, '/posts/'));
}
