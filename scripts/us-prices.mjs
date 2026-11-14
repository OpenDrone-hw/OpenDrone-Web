#!/usr/bin/env node
// Compare the Shopify US price list with the US price rule in content/us-sales.json
// and, with --apply, write one fixed USD price per active variant.
//
//   npm run us:prices -- --factory <private.json>            dry run: prints every difference, changes nothing
//   npm run us:prices -- --factory <private.json> --check    the same, exit 1 on any difference (scheduled check)
//   npm run us:prices -- --factory <private.json> --apply    writes the fixed prices, then reads them back
//
// Rule (founder 2026-11-14): US price = EUR list price / 1.21 x usdPerEur + US duty per
// unit, to the cent, no rounding. Duty per unit = factory price x (dutyPct[family] +
// feesPct) / 100. The factory price (customs value under the first-sale rule) is a
// supplier price: it is read from the --factory file ({"factoryUsd": {SKU: number}}),
// kept outside this public repository. Compare-at prices follow the same rule.
//
// The list's percentage adjustment (fallbackUpliftPct) is never written here: it only
// prices a variant without a fixed price, and this script reports such a variant as a
// difference. Run after every preorder price step: a fixed USD price does not follow a
// step on its own. Prices are money: --apply needs the founder's go. Reads
// SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN (read_products, write_products,
// read_markets) and SHOPIFY_ADMIN_API_VERSION from the environment or .env. Nothing
// secret is printed.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VERSION = '2026-07';
const BE_VAT = 0.21;

export const READ_QUERY = `#graphql
  query OpenDroneUsPrices($after: String) {
    priceLists(first: 50) {
      nodes { id name currency fixedPricesCount parent { adjustment { type value } } }
    }
    markets(first: 50) { nodes { handle priceInclusions { inclusiveTaxPricingStrategy } } }
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id sku title price compareAtPrice product { status } }
    }
  }
`;

export const FIXED_QUERY = `#graphql
  query OpenDroneUsFixed($id: ID!, $after: String) {
    priceList(id: $id) {
      prices(first: 250, after: $after, originType: FIXED) {
        pageInfo { hasNextPage endCursor }
        nodes { variant { id } price { amount currencyCode } compareAtPrice { amount } }
      }
    }
  }
`;

export const FIXED_ADD = `#graphql
  mutation OpenDroneUsFixedAdd($id: ID!, $prices: [PriceListPriceInput!]!) {
    priceListFixedPricesAdd(priceListId: $id, prices: $prices) {
      prices { variant { id } price { amount } }
      userErrors { field code message }
    }
  }
`;

const cents = (n) => Math.round(n * 100 + 1e-6) / 100;

/** The validated US price rule of content/us-sales.json. */
export function readRule(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fail = (m) => {
    throw new Error(`content/us-sales.json: ${m}`);
  };
  if (raw.priceRule !== 'base-plus-duty') fail('priceRule must be "base-plus-duty"');
  if (!(raw.usdPerEur > 0.5 && raw.usdPerEur < 2)) fail('usdPerEur must be a rate between 0.5 and 2');
  if (!(raw.feesPct >= 0 && raw.feesPct < 5)) fail('feesPct must be from 0 to 5');
  for (const [k, v] of Object.entries(raw.dutyPct ?? {})) if (!(v >= 0 && v <= 300)) fail(`dutyPct.${k} must be from 0 to 300`);
  if (!Array.isArray(raw.family) || !raw.family.every(([p, f]) => typeof p === 'string' && f in raw.dutyPct)) {
    fail('family must be [prefix, dutyPct key] pairs');
  }
  return {usdPerEur: raw.usdPerEur, feesPct: raw.feesPct, dutyPct: raw.dutyPct, family: raw.family, fallbackUpliftPct: raw.fallbackUpliftPct};
}

/** The duty family of a SKU: the first matching prefix, in file order. */
export function familyOf(sku, rule) {
  const hit = rule.family.find(([prefix]) => sku.startsWith(prefix));
  if (!hit) throw new Error(`${sku}: no US duty family in content/us-sales.json`);
  return hit[1];
}

/** US duty per unit in USD, to the cent. */
export function dutyUsd(sku, factoryUsd, rule) {
  return cents((factoryUsd * (rule.dutyPct[familyOf(sku, rule)] + rule.feesPct)) / 100);
}

/** The US price of a EUR VAT-inclusive list price: base x FX + duty, to the cent. */
export function usdPrice(eurList, duty, rule) {
  return cents((eurList / (1 + BE_VAT)) * rule.usdPerEur + duty);
}

/** The USD price list that prices the US market. */
export function findUsList(lists) {
  const matches = lists.filter((l) => l.currency === 'USD' && l.parent?.adjustment);
  if (matches.length !== 1) throw new Error(`expected exactly one USD price list, found ${matches.length}`);
  return matches[0];
}

/**
 * Fixed prices to write: one per active variant whose live fixed price or compare-at
 * differs from the rule (or that has none). `fixed` maps variant id to {price, compareAt}.
 */
export function planFixed(variants, fixed, factory, rule) {
  const plan = [];
  const missing = [];
  for (const v of variants) {
    if (v.product?.status !== 'ACTIVE') continue;
    const f = factory[v.sku];
    if (typeof f !== 'number' || !(f > 0)) {
      missing.push(v.sku);
      continue;
    }
    const duty = dutyUsd(v.sku, f, rule);
    const price = usdPrice(Number(v.price), duty, rule);
    const compare = v.compareAtPrice && Number(v.compareAtPrice) > Number(v.price) ? usdPrice(Number(v.compareAtPrice), duty, rule) : null;
    const live = fixed.get(v.id);
    const same = live && cents(live.price) === price && (live.compareAt == null ? compare == null : compare != null && cents(live.compareAt) === compare);
    if (!same) {
      plan.push({id: v.id, sku: v.sku, title: v.title, duty, from: live ?? null, price, compareAt: compare});
    }
  }
  return {plan, missing};
}

/** The mutation input of a plan. */
export function fixedInput(plan) {
  return plan.map((p) => ({
    variantId: p.id,
    price: {amount: p.price.toFixed(2), currencyCode: 'USD'},
    ...(p.compareAt != null ? {compareAtPrice: {amount: p.compareAt.toFixed(2), currencyCode: 'USD'}} : {}),
  }));
}

function loadDotenv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function admin(query, variables) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  if (!domain || !token) throw new Error('SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_TOKEN are required');
  const version = process.env.SHOPIFY_ADMIN_API_VERSION?.trim() || DEFAULT_VERSION;
  const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'X-Shopify-Access-Token': token},
    body: JSON.stringify({query, variables}),
  });
  if (!response.ok) throw new Error(`Shopify Admin API answered ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`Shopify Admin API: ${body.errors.map((e) => e.message).join('; ')}`);
  return body.data;
}

async function readLive() {
  const variants = [];
  let after = null;
  let first;
  do {
    const data = await admin(READ_QUERY, {after});
    first ??= data;
    variants.push(...data.productVariants.nodes);
    after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);
  const list = findUsList(first.priceLists.nodes);
  const us = first.markets.nodes.find((m) => m.handle === 'us');
  const fixed = new Map();
  let cursor = null;
  do {
    const page = (await admin(FIXED_QUERY, {id: list.id, after: cursor})).priceList.prices;
    for (const n of page.nodes) {
      fixed.set(n.variant.id, {price: Number(n.price.amount), compareAt: n.compareAtPrice ? Number(n.compareAtPrice.amount) : null});
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return {variants, list, fixed, taxStrategy: us?.priceInclusions?.inclusiveTaxPricingStrategy ?? null};
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run us:prices -- --factory <private.json> [--check | --apply]');
    return;
  }
  const known = new Set(['--apply', '--check', '--factory']);
  const unknown = args.filter((a, i) => !known.has(a) && args[i - 1] !== '--factory');
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const factoryFile = argValue(args, '--factory');
  if (!factoryFile) throw new Error('--factory <file> is required: the factory prices are private and not in this repository');
  const apply = args.includes('--apply');
  loadDotenv();
  const rule = readRule(path.join(ROOT, 'content/us-sales.json'));
  const factory = JSON.parse(fs.readFileSync(factoryFile, 'utf8')).factoryUsd ?? {};
  const live = await readLive();
  console.log(apply ? 'APPLY: writing US fixed prices.' : 'DRY RUN: nothing is changed.');
  console.log(`Rule: base (list / 1.21) x ${rule.usdPerEur} USD/EUR + duty; fees ${rule.feesPct}%`);
  console.log(`Shopify "${live.list.name}": ${live.list.parent.adjustment.type} ${live.list.parent.adjustment.value} (fallback), ${live.fixed.size} fixed prices; US market ${live.taxStrategy}`);
  if (live.taxStrategy !== 'INCLUDES_TAXES_IN_PRICE') {
    throw new Error(`US market uses ${live.taxStrategy}: the rule assumes INCLUDES_TAXES_IN_PRICE (no Belgian VAT deducted by Shopify); review before writing`);
  }
  const {plan, missing} = planFixed(live.variants, live.fixed, factory, rule);
  for (const sku of missing) console.log(`NO FACTORY PRICE ${sku}: priced by the +${live.list.parent.adjustment.value}% fallback`);
  for (const p of plan) {
    const from = p.from ? `${p.from.price.toFixed(2)}${p.from.compareAt != null ? ` (was ${p.from.compareAt.toFixed(2)})` : ''}` : 'none';
    console.log(`${p.sku} ${p.title}: ${from} -> ${p.price.toFixed(2)}${p.compareAt != null ? ` (was ${p.compareAt.toFixed(2)})` : ''} USD, duty ${p.duty.toFixed(2)}`);
  }
  if (!plan.length && !missing.length) {
    console.log('In sync: every active variant has its rule price.');
    return;
  }
  if (!apply) {
    console.log(`${plan.length} fixed price(s) differ. ${args.includes('--check') ? '' : 'Re-run with --apply to write them (founder\'s go: this changes prices).'}`);
    if (args.includes('--check')) process.exit(1);
    return;
  }
  const result = (await admin(FIXED_ADD, {id: live.list.id, prices: fixedInput(plan)})).priceListFixedPricesAdd;
  if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join('; '));
  const back = await readLive();
  const left = planFixed(back.variants, back.fixed, factory, rule).plan;
  if (left.length) throw new Error(`read-back: ${left.length} fixed price(s) still differ`);
  console.log(`Done: ${plan.length} fixed price(s) written and read back. Run the smoke test.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`us:prices: ${error.message}`);
    process.exit(1);
  });
}
