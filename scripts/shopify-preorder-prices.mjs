#!/usr/bin/env node
// Set the preorder price on every campaign SKU in Shopify: price = retail
// minus 20%, compare-at price = retail (the price after the funding target;
// the storefront never renders it struck through, see app/lib/catalog.ts).
//
// Retail is `standard_price_eur_vat_included` in the workspace registry
// (../../stock/product_skus.json, or STOCK_SKUS_JSON). Campaign SKUs are
// the keys of content/preorders.json. A SKU without a retail price is
// reported and left alone.
//
// Usage:
//   node scripts/shopify-preorder-prices.mjs            dry run: prints the plan
//   node scripts/shopify-preorder-prices.mjs --apply    writes the plan, then reads it back
//
// Env (.env or process env): SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN
// (needs read_products; --apply needs write_products), SHOPIFY_ADMIN_API_VERSION.
// Run once for the launch; delete after the production run.

import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISCOUNT = 0.2;
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--apply');
if (unknown.length) {
  console.error(`unknown argument: ${unknown.join(' ')}`);
  process.exit(2);
}
const APPLY = args.includes('--apply');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const env = {...loadEnv(), ...process.env};
const domain = (env.SHOPIFY_STORE_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const token = env.SHOPIFY_ADMIN_API_TOKEN;
const version = env.SHOPIFY_ADMIN_API_VERSION || '2026-07';
if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/i.test(domain) || !token) {
  console.error('SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_TOKEN are required.');
  process.exit(2);
}

const registryPath = env.STOCK_SKUS_JSON || path.resolve(ROOT, '../../stock/product_skus.json');
if (!existsSync(registryPath)) {
  console.error(`No SKU registry at ${registryPath}; set STOCK_SKUS_JSON to stock/product_skus.json.`);
  process.exit(2);
}
const registry = Object.fromEntries(
  JSON.parse(readFileSync(registryPath, 'utf8')).products.map((p) => [p.sku, p]),
);
const campaignSkus = Object.keys(
  JSON.parse(readFileSync(path.join(ROOT, 'content/preorders.json'), 'utf8')).skus,
);

async function admin(query, variables) {
  const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
    body: JSON.stringify({query, variables}),
    redirect: 'manual',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) {
    throw new Error(`Admin API ${response.status}: ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  }
  return body.data;
}

const VARIANT_QUERY = `query ($q: String!) {
  productVariants(first: 5, query: $q) {
    nodes { id sku price compareAtPrice product { id title } }
  }
}`;
const UPDATE = `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id sku price compareAtPrice }
    userErrors { field message }
  }
}`;

const cents = (n) => (Math.round(n * 100) / 100).toFixed(2);
const plan = [];
const skipped = [];
for (const sku of campaignSkus) {
  const retail = registry[sku]?.commercial?.standard_price_eur_vat_included;
  if (typeof retail !== 'number' || retail <= 0) {
    skipped.push(`${sku}: no retail price in the registry`);
    continue;
  }
  const data = await admin(VARIANT_QUERY, {q: `sku:${sku}`});
  const matches = data.productVariants.nodes.filter((v) => v.sku === sku);
  if (matches.length !== 1) {
    skipped.push(`${sku}: ${matches.length} Shopify variants carry this SKU`);
    continue;
  }
  const v = matches[0];
  const price = cents(retail * (1 - DISCOUNT));
  const compareAt = cents(retail);
  const changed = cents(Number(v.price)) !== price || cents(Number(v.compareAtPrice ?? 0)) !== compareAt;
  plan.push({sku, id: v.id, productId: v.product.id, from: [v.price, v.compareAtPrice], price, compareAt, changed});
}

console.log(`${'SKU'.padEnd(20)} ${'price now'.padStart(10)} ${'cmp now'.padStart(8)}  ->  ${'price'.padStart(7)} ${'cmp-at'.padStart(7)}`);
for (const p of plan) {
  console.log(
    `${p.sku.padEnd(20)} ${String(p.from[0]).padStart(10)} ${String(p.from[1] ?? '-').padStart(8)}  ->  ${p.price.padStart(7)} ${p.compareAt.padStart(7)}${p.changed ? '' : '   (unchanged)'}`,
  );
}
for (const s of skipped) console.log(`skipped  ${s}`);

const todo = plan.filter((p) => p.changed);
if (!APPLY) {
  console.log(`\nDry run: ${todo.length} variant(s) would change. Re-run with --apply to write.`);
  process.exit(0);
}
const byProduct = new Map();
for (const p of todo) {
  const list = byProduct.get(p.productId) ?? [];
  list.push({id: p.id, price: p.price, compareAtPrice: p.compareAt});
  byProduct.set(p.productId, list);
}
for (const [productId, variants] of byProduct) {
  const data = await admin(UPDATE, {productId, variants});
  const errors = data.productVariantsBulkUpdate.userErrors;
  if (errors.length) throw new Error(`${productId}: ${JSON.stringify(errors)}`);
}
// Read back: every planned variant must now carry the planned numbers.
let mismatches = 0;
for (const p of todo) {
  const data = await admin(VARIANT_QUERY, {q: `sku:${p.sku}`});
  const v = data.productVariants.nodes.find((n) => n.sku === p.sku);
  const ok = v && cents(Number(v.price)) === p.price && cents(Number(v.compareAtPrice ?? 0)) === p.compareAt;
  if (!ok) mismatches += 1;
  console.log(`${ok ? 'ok      ' : 'MISMATCH'} ${p.sku} ${v?.price} / ${v?.compareAtPrice}`);
}
process.exit(mismatches ? 1 : 0);
