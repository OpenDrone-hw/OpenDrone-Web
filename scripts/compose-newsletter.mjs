#!/usr/bin/env node
// Compose an Engineering Essentials email from a published blog article.
//
// Usage:
//   node scripts/compose-newsletter.mjs <article-handle>
//   node scripts/compose-newsletter.mjs <blog-handle>/<article-handle>
//
// Reads .env for PUBLIC_STORE_DOMAIN + PRIVATE_STOREFRONT_API_TOKEN,
// queries the Storefront API for the given article, then renders
// scripts/newsletter-template.html with the article's data. Output lands
// in scripts/out/newsletter-<handle>.html ready to paste into a Shopify
// Email campaign (Marketing → Campaigns → Create → Custom HTML).

import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const DEFAULT_BLOG_HANDLE = 'news';
const SITE_ORIGIN = 'https://opendrone.be';
const STOREFRONT_API_VERSION = '2026-01';

async function loadEnv() {
  const envPath = path.join(repoRoot, '.env');
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // no .env is fine if env vars are set externally
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error(
      'Usage: node scripts/compose-newsletter.mjs <blog>/<article> | <article>',
    );
    process.exit(1);
  }
  const raw = args[0];
  if (raw.includes('/')) {
    const [blog, article] = raw.split('/').filter(Boolean);
    return {blogHandle: blog, articleHandle: article};
  }
  return {blogHandle: DEFAULT_BLOG_HANDLE, articleHandle: raw};
}

const ARTICLE_QUERY = `#graphql
  query ComposeNewsletterArticle(
    $blogHandle: String!
    $articleHandle: String!
  ) {
    blog(handle: $blogHandle) {
      handle
      title
      articleByHandle(handle: $articleHandle) {
        handle
        title
        publishedAt
        contentHtml
        excerptHtml
        excerpt
        author: authorV2 {
          name
        }
        image {
          url
          altText
          width
          height
        }
      }
    }
  }
`;

async function fetchArticle({blogHandle, articleHandle}) {
  const domain = process.env.PUBLIC_STORE_DOMAIN;
  const token = process.env.PRIVATE_STOREFRONT_API_TOKEN;
  if (!domain || !token) {
    console.error(
      '[compose-newsletter] Missing PUBLIC_STORE_DOMAIN or PRIVATE_STOREFRONT_API_TOKEN in .env',
    );
    process.exit(2);
  }

  const url = `https://${domain}/api/${STOREFRONT_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Shopify-Storefront-Private-Token': token,
    },
    body: JSON.stringify({
      query: ARTICLE_QUERY,
      variables: {blogHandle, articleHandle},
    }),
  });

  if (!res.ok) {
    console.error(
      `[compose-newsletter] Storefront API HTTP ${res.status}`,
      await res.text(),
    );
    process.exit(3);
  }

  const json = await res.json();
  if (json.errors?.length) {
    console.error('[compose-newsletter] GraphQL errors', json.errors);
    process.exit(4);
  }

  const blog = json.data?.blog;
  const article = blog?.articleByHandle;
  if (!article) {
    console.error(
      `[compose-newsletter] Article not found: ${blogHandle}/${articleHandle}`,
    );
    process.exit(5);
  }
  return {blog, article};
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }).format(new Date(iso));
  } catch {
    return '';
  }
}

function issueLabel(iso) {
  try {
    const d = new Date(iso);
    const month = d
      .toLocaleString('en-US', {month: 'short'})
      .toUpperCase();
    const year = d.getFullYear();
    return `${month} ${year}`;
  } catch {
    return '';
  }
}

function buildExcerptHtml(article) {
  if (article.excerptHtml?.trim()) return article.excerptHtml;
  if (article.excerpt?.trim()) {
    return `<p style="margin:0 0 14px 0;">${escapeHtml(article.excerpt)}</p>`;
  }
  // Fallback: first paragraph from content, stripped.
  const match = article.contentHtml?.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const firstPara = match ? match[1] : '';
  const plain = firstPara.replace(/<[^>]+>/g, '').trim();
  if (plain) {
    const truncated =
      plain.length > 320 ? plain.slice(0, 317).trimEnd() + '…' : plain;
    return `<p style="margin:0 0 14px 0;">${escapeHtml(truncated)}</p>`;
  }
  return '<p style="margin:0;">Read the full article on opendrone.be.</p>';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHeroImageBlock(image) {
  if (!image?.url) return '';
  const alt = escapeHtml(image.altText || '');
  return `
            <tr>
              <td style="padding: 0 32px 24px 32px;">
                <img
                  src="${escapeHtml(image.url)}"
                  alt="${alt}"
                  width="536"
                  style="display:block; width:100%; max-width:536px; height:auto; border:1px solid #1a241a;"
                />
              </td>
            </tr>`;
}

function buildPreheader(article) {
  if (article.excerpt?.trim()) return article.excerpt.slice(0, 140);
  const para = article.contentHtml?.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const text = (para ? para[1] : '').replace(/<[^>]+>/g, '').trim();
  return text.slice(0, 140);
}

async function render({article}) {
  const templatePath = path.join(__dirname, 'newsletter-template.html');
  let html = await fs.readFile(templatePath, 'utf8');

  const articleUrl = `${SITE_ORIGIN}/newsletter/${article.handle}`;
  const replacements = {
    SUBJECT: article.title,
    PREHEADER: buildPreheader(article),
    ISSUE_LABEL: issueLabel(article.publishedAt),
    TITLE: escapeHtml(article.title),
    PUBLISHED_DATE: formatDate(article.publishedAt),
    EXCERPT_HTML: buildExcerptHtml(article),
    HERO_IMAGE_BLOCK: buildHeroImageBlock(article.image),
    ARTICLE_URL: articleUrl,
  };

  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }

  return {html, articleUrl};
}

async function main() {
  await loadEnv();
  const {blogHandle, articleHandle} = parseArgs(process.argv);

  console.log(
    `\n[compose-newsletter] Fetching ${blogHandle}/${articleHandle}…`,
  );
  const {article} = await fetchArticle({blogHandle, articleHandle});

  const {html, articleUrl} = await render({article});

  const outDir = path.join(__dirname, 'out');
  await fs.mkdir(outDir, {recursive: true});
  const outPath = path.join(outDir, `newsletter-${article.handle}.html`);
  await fs.writeFile(outPath, html, 'utf8');

  const relOut = path.relative(repoRoot, outPath);
  const subject = article.title;

  console.log(`\n✓ Rendered email → ${relOut}`);
  console.log(`\nPreview: open ${relOut} in a browser`);
  console.log(`\n── Copy into Shopify Email ─────────────────────────────`);
  console.log(`Subject:     ${subject}`);
  console.log(`Preheader:   ${buildPreheader(article)}`);
  console.log(`Article URL: ${articleUrl}`);
  console.log(`────────────────────────────────────────────────────────`);
  console.log(
    `\nNext: Shopify admin → Marketing → Campaigns → Create campaign`,
  );
  console.log(
    `       → Shopify Email → Custom HTML → paste contents of ${relOut}`,
  );
  console.log(
    `       Audience: customers with Email subscription status = Subscribed\n`,
  );
}

main().catch((err) => {
  console.error('[compose-newsletter] failed', err);
  process.exit(1);
});
