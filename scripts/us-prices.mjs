#!/usr/bin/env node
// Compare the Shopify fixed-price lists of the non-EU markets with the price rule in
// content/us-sales.json and, with --apply, write one fixed price per active variant:
//   United States (USD list): the US rule below.
//   International (EUR list, -intlDecreasePct % fallback): base with a price ending.
//   United Kingdom (GBP list, once it exists): base x gbpPerEur x (1 + ukVatPct) with an ending.
// Belgium and the EU keep the EUR list price and have no list here.
//
//   npm run us:prices -- --factory <private.json>            dry run: prints every difference, changes nothing
//   npm run us:prices -- --factory <private.json> --check    the same, exit 1 on any difference (scheduled check)
//   npm run us:prices -- --factory <private.json> --apply    writes the fixed prices, then reads them back
//
// Rule (founder 2026-11-14: one base price before tax, the same margin in every market):
// US price = base x usdPerEur x (1 + fulfilmentPct / 100) + duty + freight, then the
// nearest price ending in `endings` (.00, .50, .90). Base = EUR list price / 1.21.
// Duty per unit = factory price x (dutyPct[family] + feesPct) / 100. Freight per unit =
// unitKg[prefix] x freightUsdPerKg (air, Shenzhen to Houston, with clearance).
// fulfilmentPct is the US fulfilment cost per order above the shipping the buyer pays,
// as a share of an average order's base value. The factory price (customs value under
// the first-sale rule) is a supplier price: it is read from the --factory file
// ({"factoryUsd": {SKU: number}}), kept outside this public repository. Compare-at
// prices follow the same rule.
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
  if (raw.priceRule !== 'base-plus-landed-cost') fail('priceRule must be "base-plus-landed-cost"');
  if (!(raw.usdPerEur > 0.5 && raw.usdPerEur < 2)) fail('usdPerEur must be a rate between 0.5 and 2');
  if (!(raw.feesPct >= 0 && raw.feesPct < 5)) fail('feesPct must be from 0 to 5');
  for (const [k, v] of Object.entries(raw.dutyPct ?? {})) if (!(v >= 0 && v <= 300)) fail(`dutyPct.${k} must be from 0 to 300`);
  if (!Array.isArray(raw.family) || !raw.family.every(([p, f]) => typeof p === 'string' && f in raw.dutyPct)) {
    fail('family must be [prefix, dutyPct key] pairs');
  }
  if (!(raw.freightUsdPerKg >= 0 && raw.freightUsdPerKg < 50)) fail('freightUsdPerKg must be from 0 to 50');
  if (!(raw.fulfilmentPct >= 0 && raw.fulfilmentPct < 30)) fail('fulfilmentPct must be from 0 to 30');
  if (!Array.isArray(raw.unitKg) || !raw.unitKg.every(([p, kg]) => typeof p === 'string' && kg > 0 && kg < 5)) {
    fail('unitKg must be [prefix, kg] pairs');
  }
  if (!Array.isArray(raw.endings) || !raw.endings.length || !raw.endings.every((e) => e >= 0 && e < 1)) {
    fail('endings must be fractions from 0 to below 1');
  }
  if (!(raw.intlDecreasePct > 0 && raw.intlDecreasePct < 50)) fail('intlDecreasePct must be from 0 to 50');
  if (!(raw.gbpPerEur > 0.5 && raw.gbpPerEur < 2)) fail('gbpPerEur must be a rate between 0.5 and 2');
  if (!(raw.ukVatPct >= 0 && raw.ukVatPct < 30)) fail('ukVatPct must be from 0 to 30');
  return {
    usdPerEur: raw.usdPerEur,
    feesPct: raw.feesPct,
    dutyPct: raw.dutyPct,
    family: raw.family,
    freightUsdPerKg: raw.freightUsdPerKg,
    unitKg: raw.unitKg,
    fulfilmentPct: raw.fulfilmentPct,
    endings: raw.endings,
    intlDecreasePct: raw.intlDecreasePct,
    gbpPerEur: raw.gbpPerEur,
    ukVatPct: raw.ukVatPct,
    fallbackUpliftPct: raw.fallbackUpliftPct,
  };
}

/** The duty family of a SKU: the first matching prefix, in file order. */
export function familyOf(sku, rule) {
  const hit = rule.family.find(([prefix]) => sku.startsWith(prefix));
  if (!hit) throw new Error(`${sku}: no US duty family in content/us-sales.json`);
  return hit[1];
}

/** US duty and fees per unit in USD (not rounded: it is one term of the price). */
export function dutyUsd(sku, factoryUsd, rule) {
  return (factoryUsd * (rule.dutyPct[familyOf(sku, rule)] + rule.feesPct)) / 100;
}

/** Packed weight per unit in kg: the first matching prefix, in file order. */
export function unitKgOf(sku, rule) {
  const hit = rule.unitKg.find(([prefix]) => sku.startsWith(prefix));
  if (!hit) throw new Error(`${sku}: no unitKg in content/us-sales.json`);
  return hit[1];
}

/** The nearest price ending (.00, .50, .90 by default); a tie goes to the higher price. */
export function withEnding(x, endings) {
  const whole = Math.trunc(x);
  let best = null;
  for (const w of [whole - 1, whole, whole + 1]) {
    for (const e of endings) {
      const c = w + e;
      if (c <= 0) continue;
      if (best === null || Math.abs(c - x) < Math.abs(best - x) || (Math.abs(c - x) === Math.abs(best - x) && c > best)) best = c;
    }
  }
  return cents(best);
}

/** The US price of a EUR VAT-inclusive list price: base x FX x (1 + fulfilment) + duty + freight, with an ending. */
export function usdPrice(eurList, sku, factoryUsd, rule) {
  const base = eurList / (1 + BE_VAT);
  const exact =
    base * rule.usdPerEur +
    dutyUsd(sku, factoryUsd, rule) +
    unitKgOf(sku, rule) * rule.freightUsdPerKg +
    base * rule.usdPerEur * (rule.fulfilmentPct / 100);
  return withEnding(exact, rule.endings);
}

/** The International EUR price of a EUR VAT-inclusive list price: the base with an ending. */
export function intlPrice(eurList, rule) {
  return withEnding(eurList / (1 + BE_VAT), rule.endings);
}

/** The UK GBP price, UK VAT inside: base x gbpPerEur x (1 + ukVatPct), with an ending. */
export function ukPrice(eurList, rule) {
  return withEnding((eurList / (1 + BE_VAT)) * rule.gbpPerEur * (1 + rule.ukVatPct / 100), rule.endings);
}

/** The International base-price list (EUR, -intlDecreasePct %) and the UK list (GBP), when they exist. */
export function findOtherLists(lists, rule) {
  const intl = lists.filter(
    (l) => l.currency === 'EUR' && l.parent?.adjustment?.type === 'PERCENTAGE_DECREASE' && Math.abs(l.parent.adjustment.value - rule.intlDecreasePct) < 0.001,
  );
  const uk = lists.filter((l) => l.currency === 'GBP' && l.parent?.adjustment);
  if (intl.length > 1 || uk.length > 1) throw new Error(`expected at most one International and one GBP price list, found ${intl.length} and ${uk.length}`);
  return {intl: intl[0] ?? null, uk: uk[0] ?? null};
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
  return planFixedBy(variants, fixed, (eur, v) => {
    const f = factory[v.sku];
    if (typeof f !== 'number' || !(f > 0)) return null;
    return {price: usdPrice(eur, v.sku, f, rule), duty: cents(dutyUsd(v.sku, f, rule))};
  });
}

/**
 * The same plan for any list: `priceOf(eurList, variant)` gives {price, duty?} or null
 * (no rule price: reported as missing, priced by the list's fallback adjustment).
 */
export function planFixedBy(variants, fixed, priceOf) {
  const plan = [];
  const missing = [];
  for (const v of variants) {
    if (v.product?.status !== 'ACTIVE') continue;
    const now = priceOf(Number(v.price), v);
    if (!now) {
      missing.push(v.sku);
      continue;
    }
    const {price, duty = null} = now;
    const compare = v.compareAtPrice && Number(v.compareAtPrice) > Number(v.price) ? priceOf(Number(v.compareAtPrice), v).price : null;
    const live = fixed.get(v.id);
    const same = live && cents(live.price) === price && (live.compareAt == null ? compare == null : compare != null && cents(live.compareAt) === compare);
    if (!same) {
      plan.push({id: v.id, sku: v.sku, title: v.title, duty, from: live ?? null, price, compareAt: compare});
    }
  }
  return {plan, missing};
}

/** The mutation input of a plan. */
export function fixedInput(plan, currencyCode = 'USD') {
  return plan.map((p) => ({
    variantId: p.id,
    price: {amount: p.price.toFixed(2), currencyCode},
    ...(p.compareAt != null ? {compareAtPrice: {amount: p.compareAt.toFixed(2), currencyCode}} : {}),
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

async function readLive(rule) {
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
  const other = findOtherLists(first.priceLists.nodes, rule);
  const us = first.markets.nodes.find((m) => m.handle === 'us');
  const fixedOf = async (l) => {
    const fixed = new Map();
    let cursor = null;
    do {
      const page = (await admin(FIXED_QUERY, {id: l.id, after: cursor})).priceList.prices;
      for (const n of page.nodes) {
        fixed.set(n.variant.id, {price: Number(n.price.amount), compareAt: n.compareAtPrice ? Number(n.compareAtPrice.amount) : null});
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return fixed;
  };
  const lists = [{name: 'US', list, currency: 'USD', fixed: await fixedOf(list)}];
  if (other.intl) lists.push({name: 'International', list: other.intl, currency: 'EUR', fixed: await fixedOf(other.intl)});
  if (other.uk) lists.push({name: 'UK', list: other.uk, currency: 'GBP', fixed: await fixedOf(other.uk)});
  const taxStrategies = Object.fromEntries(first.markets.nodes.map((m) => [m.handle, m.priceInclusions?.inclusiveTaxPricingStrategy ?? null]));
  return {variants, lists, taxStrategy: us?.priceInclusions?.inclusiveTaxPricingStrategy ?? null, taxStrategies};
}

/** Per list: the plan of fixed prices that differ from the rule. */
export function planAll(variants, lists, factory, rule) {
  return lists.map((l) => {
    const {plan, missing} =
      l.currency === 'USD'
        ? planFixed(variants, l.fixed, factory, rule)
        : planFixedBy(variants, l.fixed, (eur) => ({price: l.currency === 'EUR' ? intlPrice(eur, rule) : ukPrice(eur, rule)}));
    return {...l, plan, missing};
  });
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
  const live = await readLive(rule);
  console.log(apply ? 'APPLY: writing fixed prices.' : 'DRY RUN: nothing is changed.');
  console.log(`US rule: base (list / 1.21) x ${rule.usdPerEur} USD/EUR x (1 + ${rule.fulfilmentPct}%) + duty (fees ${rule.feesPct}%) + kg x ${rule.freightUsdPerKg} USD; International: base; UK: base x ${rule.gbpPerEur} GBP/EUR x (1 + ${rule.ukVatPct}%); ending ${rule.endings.join('/')}`);
  for (const [handle, strategy] of Object.entries(live.taxStrategies)) {
    if (handle !== 'be' && strategy !== 'INCLUDES_TAXES_IN_PRICE') {
      throw new Error(`market ${handle} uses ${strategy}: the rule assumes INCLUDES_TAXES_IN_PRICE (no Belgian VAT deducted by Shopify); review before writing`);
    }
  }
  const plans = planAll(live.variants, live.lists, factory, rule);
  let differ = 0;
  for (const l of plans) {
    console.log(`Shopify "${l.list.name}" (${l.name}): ${l.list.parent.adjustment.type} ${l.list.parent.adjustment.value} (fallback), ${l.fixed.size} fixed prices`);
    for (const sku of l.missing) console.log(`  NO FACTORY PRICE ${sku}: priced by the ${l.list.parent.adjustment.value}% fallback`);
    for (const p of l.plan) {
      const from = p.from ? `${p.from.price.toFixed(2)}${p.from.compareAt != null ? ` (was ${p.from.compareAt.toFixed(2)})` : ''}` : 'none';
      console.log(`  ${p.sku} ${p.title}: ${from} -> ${p.price.toFixed(2)}${p.compareAt != null ? ` (was ${p.compareAt.toFixed(2)})` : ''} ${l.currency}${p.duty != null ? `, duty ${p.duty.toFixed(2)}` : ''}`);
    }
    differ += l.plan.length + l.missing.length;
  }
  if (!differ) {
    console.log('In sync: every active variant has its rule price in every list.');
    return;
  }
  if (!apply) {
    console.log(`${differ} fixed price(s) differ. ${args.includes('--check') ? '' : 'Re-run with --apply to write them (founder\'s go: this changes prices).'}`);
    if (args.includes('--check')) process.exit(1);
    return;
  }
  for (const l of plans) {
    if (!l.plan.length) continue;
    const result = (await admin(FIXED_ADD, {id: l.list.id, prices: fixedInput(l.plan, l.currency)})).priceListFixedPricesAdd;
    if (result.userErrors?.length) throw new Error(`${l.name}: ${result.userErrors.map((e) => e.message).join('; ')}`);
  }
  const again = await readLive(rule);
  const back = planAll(again.variants, again.lists, factory, rule);
  const left = back.reduce((n, l) => n + l.plan.length, 0);
  if (left) throw new Error(`read-back: ${left} fixed price(s) still differ`);
  console.log(`Done: ${plans.reduce((n, l) => n + l.plan.length, 0)} fixed price(s) written and read back. Run the smoke test.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`us:prices: ${error.message}`);
    process.exit(1);
  });
}
