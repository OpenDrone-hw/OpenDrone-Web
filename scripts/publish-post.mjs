#!/usr/bin/env node
// Publish a local Markdown post to the Shopify blog.
//
// Usage:
//   node scripts/publish-post.mjs <path-to-md>            create/update + publish
//   node scripts/publish-post.mjs <path-to-md> --draft    push as a Shopify draft
//   node scripts/publish-post.mjs <path-to-md> --dry      render HTML only, no API
//
// Flow (live): parse front-matter + body → render Markdown to HTML → upload
// hero + inline images to Shopify Files (write_files) and rewrite their URLs
// to the CDN → resolve the target blog by handle → create or update the
// article by slug (idempotent). Article writes need the read_content +
// write_content Admin API scopes on the custom app; if they're missing the
// script stops with a clear message and the Files uploads it already did are
// harmless (re-runs reuse them via the local cache).
//
// Source of truth is the Markdown file. Re-running overwrites the Shopify
// copy — never hand-edit the article in the admin. See the Editing content
// section in the root README.md.

import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {marked} from 'marked';
import {admin, assertNoUserErrors, SHOP} from './shopify-infra/_client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(__dirname, '.post-uploads.json');

const SITE_ORIGIN = 'https://opendrone.be';
const POST_PATH = 'newsletter'; // public URL is `${SITE_ORIGIN}/${POST_PATH}/<slug>`
const DEFAULT_BLOG_HANDLE = 'news';
const DEFAULT_AUTHOR = 'OpenDrone';

// --- args ------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length !== 1) {
    console.error(
      'Usage: node scripts/publish-post.mjs <path-to-md> [--draft] [--dry]',
    );
    process.exit(1);
  }
  return {
    file: positional[0],
    dry: flags.has('--dry'),
    draft: flags.has('--draft'),
  };
}

// --- front-matter ----------------------------------------------------------

// Minimal front-matter parser: a leading `---` block of `key: value` lines.
// Values: quoted/plain strings, true/false, and `[a, b]` or `a, b` lists.
function parseFrontMatter(raw) {
  if (!raw.startsWith('---')) {
    throw new Error('missing front-matter (file must start with `---`)');
  }
  const end = raw.indexOf('\n---', 3);
  if (end === -1) throw new Error('unterminated front-matter block');
  const block = raw.slice(3, end).trim();
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1).replace(/^\s+/, '');

  const fm = {};
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    fm[key] = parseValue(trimmed.slice(colon + 1).trim());
  }
  return {fm, body};
}

function parseValue(v) {
  if (v === '') return '';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return v;
}

function toTags(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toPublishDate(date) {
  if (!date) return new Date().toISOString();
  // `YYYY-MM-DD` → start of day UTC. The site formats publishedAt in UTC,
  // so this displays the intended date without slipping, and stays in the
  // past for "today" (Shopify rejects a future date on a published post).
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date))
    ? new Date(`${date}T00:00:00Z`)
    : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${date}`);
  return d.toISOString();
}

// --- image upload (Shopify Files) ------------------------------------------

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  const m = MIME[ext];
  if (!m) throw new Error(`unsupported image type: ${file}`);
  return m;
}

let cache = {};
async function loadCache() {
  try {
    cache = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  } catch {
    cache = {};
  }
}
async function saveCache() {
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

const STAGED_UPLOADS_CREATE = `
  mutation StagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

const FILE_CREATE = `
  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus alt ... on MediaImage { image { url } } }
      userErrors { field message }
    }
  }
`;

const FILE_NODE = `
  query FileNode($id: ID!) {
    node(id: $id) {
      ... on MediaImage { id fileStatus image { url } }
    }
  }
`;

async function uploadImage(absPath, alt) {
  const stat = await fs.stat(absPath).catch(() => {
    throw new Error(`image not found: ${path.relative(REPO_ROOT, absPath)}`);
  });
  const key = `${absPath}:${stat.mtimeMs}:${stat.size}`;
  if (cache[key]) return {url: cache[key], cached: true};

  const filename = `post-${path.basename(absPath)}`;
  const mimeType = mimeFor(absPath);

  const staged = await admin(STAGED_UPLOADS_CREATE, {
    input: [{filename, mimeType, httpMethod: 'POST', resource: 'IMAGE'}],
  });
  assertNoUserErrors('stagedUploadsCreate', staged.stagedUploadsCreate);
  const target = staged.stagedUploadsCreate.stagedTargets[0];

  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  const buf = await fs.readFile(absPath);
  form.append('file', new Blob([buf], {type: mimeType}), filename);
  const up = await fetch(target.url, {method: 'POST', body: form});
  if (![200, 201, 204].includes(up.status)) {
    throw new Error(
      `staged upload POST failed (${up.status}): ${(await up.text()).slice(0, 200)}`,
    );
  }

  const created = await admin(FILE_CREATE, {
    files: [{originalSource: target.resourceUrl, contentType: 'IMAGE', alt: alt || filename}],
  });
  assertNoUserErrors('fileCreate', created.fileCreate);
  const file = created.fileCreate.files[0];

  const url = await pollFileUrl(file.id);
  cache[key] = url;
  await saveCache();
  return {url, cached: false};
}

async function pollFileUrl(id) {
  for (let i = 0; i < 30; i++) {
    const data = await admin(FILE_NODE, {id});
    const node = data.node;
    if (node?.fileStatus === 'READY' && node.image?.url) return node.image.url;
    if (node?.fileStatus === 'FAILED') {
      throw new Error(`Shopify failed to process image ${id}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for image ${id} to process`);
}

// Replace local image sources (hero + inline) with uploaded CDN URLs.
async function resolveImages(html, postDir, dry) {
  const localSrc = /(<img[^>]+src=")(?!https?:|\/\/|data:)([^"]+)(")/gi;
  const found = [];
  for (const m of html.matchAll(localSrc)) found.push(m[2]);

  if (dry) {
    for (const src of found) console.log(`  would upload  ${src}`);
    return html;
  }

  for (const src of found) {
    const abs = path.resolve(postDir, src);
    const {url, cached} = await uploadImage(abs, '');
    html = html.split(`src="${src}"`).join(`src="${url}"`);
    console.log(`  ${cached ? 'reused      ' : 'uploaded    '}  ${src}`);
  }
  return html;
}

// --- blog + article --------------------------------------------------------

async function resolveBlogId(handle) {
  const data = await admin(`{ blogs(first: 50) { nodes { id handle } } }`);
  const blog = data.blogs.nodes.find((b) => b.handle === handle);
  if (!blog) {
    const have = data.blogs.nodes.map((b) => b.handle).join(', ') || '(none)';
    throw new Error(`blog "${handle}" not found. Existing blogs: ${have}`);
  }
  return blog.id;
}

async function findArticleId(blogId, slug) {
  const data = await admin(
    `query($id: ID!) { blog(id: $id) { articles(first: 250) { nodes { id handle } } } }`,
    {id: blogId},
  );
  const hit = data.blog.articles.nodes.find((a) => a.handle === slug);
  return hit?.id ?? null;
}

const ARTICLE_CREATE = `
  mutation ArticleCreate($article: ArticleCreateInput!) {
    articleCreate(article: $article) {
      article { id handle }
      userErrors { field message }
    }
  }
`;

const ARTICLE_UPDATE = `
  mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article { id handle }
      userErrors { field message }
    }
  }
`;

// --- main ------------------------------------------------------------------

async function main() {
  const {file, dry, draft} = parseArgs(process.argv);
  const abs = path.resolve(process.cwd(), file);
  const postDir = path.dirname(abs);

  const raw = await fs.readFile(abs, 'utf8').catch(() => {
    throw new Error(`cannot read ${file}`);
  });
  const {fm, body} = parseFrontMatter(raw);

  if (!fm.title) throw new Error('front-matter `title` is required');
  const slug = slugify(fm.slug || path.basename(abs, path.extname(abs)));
  const tags = toTags(fm.tags);
  const author = fm.author || DEFAULT_AUTHOR;
  const blogHandle = fm.blog || DEFAULT_BLOG_HANDLE;
  let publishDate = toPublishDate(fm.date);
  const isPublished = !draft && fm.published !== false;
  // Shopify forbids isPublished:true with a future publishDate. If a live
  // post's date is still ahead of now, publish it now instead. (To schedule,
  // set `published: false` and a future date — Shopify auto-publishes.)
  if (isPublished && new Date(publishDate).getTime() > Date.now()) {
    publishDate = new Date().toISOString();
  }

  marked.setOptions({gfm: true, breaks: false});
  let html = marked.parse(body).trim();

  console.log(`\n[publish-post] ${slug}  (blog: ${blogHandle})`);
  await loadCache();

  // Inline body images.
  html = await resolveImages(html, postDir, dry);

  // Hero image.
  let heroUrl = null;
  if (fm.image) {
    const heroAbs = path.resolve(postDir, fm.image);
    if (dry) {
      console.log(`  would upload  ${fm.image}  (hero)`);
    } else {
      const hero = await uploadImage(heroAbs, fm.imageAlt || fm.title);
      heroUrl = hero.url;
      console.log(`  ${hero.cached ? 'reused      ' : 'uploaded    '}  ${fm.image}  (hero)`);
    }
  }

  if (dry) {
    const outDir = path.join(__dirname, 'out');
    await fs.mkdir(outDir, {recursive: true});
    const outPath = path.join(outDir, `post-${slug}.html`);
    await fs.writeFile(outPath, html);
    console.log(`\n✓ Dry run. Rendered HTML → ${path.relative(REPO_ROOT, outPath)}`);
    console.log(`  Title:   ${fm.title}`);
    console.log(`  Summary: ${fm.summary || '(first paragraph will be used)'}`);
    console.log(`  Tags:    ${tags.join(', ') || '(none)'}`);
    console.log(`  State:   ${isPublished ? 'would PUBLISH' : 'would save as DRAFT'}`);
    console.log('  No Shopify changes made.\n');
    return;
  }

  const blogId = await resolveBlogId(blogHandle);
  const existingId = await findArticleId(blogId, slug);

  const article = {
    blogId,
    title: fm.title,
    handle: slug,
    body: html,
    tags,
    author: {name: author},
    isPublished,
  };
  // Only send publishDate when actually publishing. Sending a past date with
  // isPublished:false makes Shopify treat it as a scheduled time that already
  // passed → it publishes anyway, so `--draft` would silently go live.
  if (isPublished) article.publishDate = publishDate;
  if (fm.summary) article.summary = `<p>${escapeHtml(fm.summary)}</p>`;
  if (heroUrl) article.image = {url: heroUrl, altText: fm.imageAlt || fm.title};

  let result;
  if (existingId) {
    const data = await admin(ARTICLE_UPDATE, {id: existingId, article});
    assertNoUserErrors('articleUpdate', data.articleUpdate);
    result = data.articleUpdate.article;
    console.log(`  updated existing article`);
  } else {
    const data = await admin(ARTICLE_CREATE, {article});
    assertNoUserErrors('articleCreate', data.articleCreate);
    result = data.articleCreate.article;
    console.log(`  created new article`);
  }

  console.log(`\n✓ ${isPublished ? 'Published' : 'Saved as draft'}: ${result.handle}`);
  console.log(`  Live:  ${SITE_ORIGIN}/${POST_PATH}/${result.handle}`);
  console.log(`  Admin: https://${SHOP.replace(/\.myshopify\.com$/, '')}.myshopify.com/admin/articles`);
  if (isPublished) {
    console.log(
      `\nNext: Shopify admin → Marketing → Create campaign → Shopify Email →\n` +
        `      blog-post template → audience "Email subscribers" → review → Send.\n`,
    );
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

main().catch((err) => {
  const msg = err?.message ?? String(err);
  if (/ACCESS_DENIED|Access denied/i.test(msg) && /content|blog|article/i.test(msg)) {
    console.error(
      '\n[publish-post] Admin API denied access to blog content.\n' +
        'Add read_content + write_content to the "OpenDrone Infra" custom app\n' +
        '(Settings → Apps → Develop apps → Configuration), reinstall, and update\n' +
        'SHOPIFY_ADMIN_API_TOKEN in .env. See README.md (Editing content).\n',
    );
  } else {
    console.error(`\n[publish-post] failed: ${msg}\n`);
  }
  process.exit(1);
});
