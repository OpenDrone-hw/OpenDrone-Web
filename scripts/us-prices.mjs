#!/usr/bin/env node
// Compare the non-EU price lists in Shopify with content/us-sales.json and, with
// --apply, write the file's values:
//   United States (USD list): the EUR VAT-inclusive list price + priceUpliftPct, as the
//     list's percentage adjustment (name "United States USD, duties included (+25%)").
//     Shopify converts and rounds. No fixed USD prices are planned or written.
//   International (EUR list, -intlDecreasePct % fallback): one fixed price per active
//     variant, the base price (list / 1.21) with the nearest ending in basePrice.endings.
//   United Kingdom (GBP list, once it exists): base x gbpPerEur x (1 + ukVatPct / 100)
//     with an ending, UK VAT inside.
// Belgium and the EU keep the EUR list price and have no list here.
//
//   npm run us:prices                 dry run: prints every difference, changes nothing
//   npm run us:prices -- --check      the same, exit 1 on any difference (scheduled check)
//   npm run us:prices -- --apply      writes the differences, then reads them back
//
// A fixed price does not follow a preorder price step on its own: run this after every
// step. Prices are money: --apply needs the founder's go. Reads SHOPIFY_STORE_DOMAIN,
// SHOPIFY_ADMIN_API_TOKEN (read_products, write_products, read_markets) and
// SHOPIFY_ADMIN_API_VERSION from the environment or .env. Nothing secret is printed.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VERSION = '2026-07';
const BE_VAT = 0.21;

export const READ_QUERY = `#graphql
  query OpenDroneNonEuPrices($after: String) {
    priceLists(first: 50) {
      nodes { id name currency parent { adjustment { type value } } }
    }
    markets(first: 50) { nodes { handle priceInclusions { inclusiveTaxPricingStrategy } } }
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id sku title price compareAtPrice product { status } }
    }
  }
`;

export const FIXED_QUERY = `#graphql
  query OpenDroneNonEuFixed($id: ID!, $after: String) {
    priceList(id: $id) {
      prices(first: 250, after: $after, originType: FIXED) {
        pageInfo { hasNextPage endCursor }
        nodes { variant { id } price { amount currencyCode } compareAtPrice { amount } }
      }
    }
  }
`;

export const FIXED_ADD = `#graphql
  mutation OpenDroneNonEuFixedAdd($id: ID!, $prices: [PriceListPriceInput!]!) {
    priceListFixedPricesAdd(priceListId: $id, prices: $prices) {
      prices { variant { id } price { amount } }
      userErrors { field code message }
    }
  }
`;

export const PRICE_LIST_UPDATE = `#graphql
  mutation OpenDroneUsPriceList($id: ID!, $input: PriceListUpdateInput!) {
    priceListUpdate(id: $id, input: $input) {
      priceList { id name parent { adjustment { type value } } }
      userErrors { field message }
    }
  }
`;

const cents = (n) => Math.round(n * 100 + 1e-6) / 100;

/** The validated rule of content/us-sales.json: the US uplift and the base-price rule. */
export function readRule(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const fail = (m) => {
    throw new Error(`content/us-sales.json: ${m}`);
  };
  const pct = raw.priceUpliftPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 300) fail('priceUpliftPct must be a number from 0 to 300');
  const b = raw.basePrice ?? {};
  if (!Array.isArray(b.endings) || !b.endings.length || !b.endings.every((e) => e >= 0 && e < 1)) {
    fail('basePrice.endings must be fractions from 0 to below 1');
  }
  if (!(b.intlDecreasePct > 0 && b.intlDecreasePct < 50)) fail('basePrice.intlDecreasePct must be from 0 to 50');
  if (!(b.gbpPerEur > 0.5 && b.gbpPerEur < 2)) fail('basePrice.gbpPerEur must be a rate between 0.5 and 2');
  if (!(b.ukVatPct >= 0 && b.ukVatPct < 30)) fail('basePrice.ukVatPct must be from 0 to 30');
  return {priceUpliftPct: pct, endings: b.endings, intlDecreasePct: b.intlDecreasePct, gbpPerEur: b.gbpPerEur, ukVatPct: b.ukVatPct};
}

/** The name with its "(+N%)" suffix set to `pct`; appended when absent. */
export function nameWithUplift(name, pct) {
  const suffix = `(+${pct}%)`;
  return /\(\+[\d.]+%\)\s*$/.test(name) ? name.replace(/\(\+[\d.]+%\)\s*$/, suffix) : `${name} ${suffix}`;
}

/** The USD price list that is a percentage increase on the EUR price. */
export function findUsList(lists) {
  const matches = lists.filter((l) => l.currency === 'USD' && l.parent?.adjustment?.type === 'PERCENTAGE_INCREASE');
  if (matches.length !== 1) {
    throw new Error(`expected exactly one USD PERCENTAGE_INCREASE price list, found ${matches.length}`);
  }
  return matches[0];
}

/** What the run would change on the US list, or null when Shopify already matches. */
export function planUplift(list, pct) {
  const live = Number(list.parent.adjustment.value);
  const name = nameWithUplift(list.name, pct);
  if (live === pct && name === list.name) return null;
  return {id: list.id, from: live, to: pct, name: {from: list.name, to: name}};
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
    (l) => l.currency === 'EUR' && l.parent?.adjustment?.type === 'PERCENTAGE_DECREASE' && Math.abs(l.parent.adjustment.value - rule.intlDecreasePct) <= 0.01,
  );
  const uk = lists.filter((l) => l.currency === 'GBP' && l.parent?.adjustment);
  if (intl.length > 1 || uk.length > 1) throw new Error(`expected at most one International and one GBP price list, found ${intl.length} and ${uk.length}`);
  return {intl: intl[0] ?? null, uk: uk[0] ?? null};
}

/**
 * Fixed prices to write on one list: one per active variant whose live fixed price or
 * compare-at differs from `priceOf(eurList)` (or that has none). `fixed` maps variant id
 * to {price, compareAt}.
 */
export function planFixedBy(variants, fixed, priceOf) {
  const plan = [];
  for (const v of variants) {
    if (v.product?.status !== 'ACTIVE') continue;
    const price = priceOf(Number(v.price));
    const compare = v.compareAtPrice && Number(v.compareAtPrice) > Number(v.price) ? priceOf(Number(v.compareAtPrice)) : null;
    const live = fixed.get(v.id);
    const same = live && cents(live.price) === price && (live.compareAt == null ? compare == null : compare != null && cents(live.compareAt) === compare);
    if (!same) plan.push({id: v.id, sku: v.sku, title: v.title, from: live ?? null, price, compareAt: compare});
  }
  return plan;
}

/** The mutation input of a plan. */
export function fixedInput(plan, currencyCode) {
  return plan.map((p) => ({
    variantId: p.id,
    price: {amount: p.price.toFixed(2), currencyCode},
    // An explicit null clears a stale struck-through price: leaving the field out keeps it.
    compareAtPrice: p.compareAt != null ? {amount: p.compareAt.toFixed(2), currencyCode} : null,
  }));
}

/** Per fixed-price list (International, UK): the plan of fixed prices that differ from the rule. */
export function planAll(variants, lists, rule) {
  return lists.map((l) => ({
    ...l,
    plan: planFixedBy(variants, l.fixed, (eur) => (l.currency === 'GBP' ? ukPrice(eur, rule) : intlPrice(eur, rule))),
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
  const us = findUsList(first.priceLists.nodes);
  const other = findOtherLists(first.priceLists.nodes, rule);
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
  const lists = [];
  if (other.intl) lists.push({name: 'International', list: other.intl, currency: 'EUR', fixed: await fixedOf(other.intl)});
  if (other.uk) lists.push({name: 'UK', list: other.uk, currency: 'GBP', fixed: await fixedOf(other.uk)});
  const taxStrategies = Object.fromEntries(first.markets.nodes.map((m) => [m.handle, m.priceInclusions?.inclusiveTaxPricingStrategy ?? null]));
  return {variants, us, lists, taxStrategies};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run us:prices [-- --check | --apply]\nDry run by default; --check exits 1 on a difference; --apply writes the US uplift and the International and UK fixed prices.');
    return;
  }
  const unknown = args.filter((a) => a !== '--apply' && a !== '--check');
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const apply = args.includes('--apply');
  const check = args.includes('--check');
  loadDotenv();
  const rule = readRule(path.join(ROOT, 'content/us-sales.json'));
  const live = await readLive(rule);
  console.log(apply ? 'APPLY: writing to Shopify.' : 'DRY RUN: nothing is changed.');
  console.log(`US: list price +${rule.priceUpliftPct}%; International: base (list / 1.21); UK: base x ${rule.gbpPerEur} GBP/EUR x (1 + ${rule.ukVatPct}%); ending ${rule.endings.join('/')}`);

  const usPlan = planUplift(live.us, rule.priceUpliftPct);
  console.log(`Shopify "${live.us.name}" (US): ${live.us.parent.adjustment.type} ${live.us.parent.adjustment.value}`);
  if (usPlan) console.log(`  adjustment ${usPlan.from} -> ${usPlan.to}; name "${usPlan.name.from}" -> "${usPlan.name.to}"`);
  if (!live.lists.length) console.log(`No International base-price list (EUR, -${rule.intlDecreasePct}%) yet: nothing to compare outside the US.`);
  if (live.lists.length) {
    for (const [handle, strategy] of Object.entries(live.taxStrategies)) {
      if (handle !== 'be' && strategy !== 'INCLUDES_TAXES_IN_PRICE') {
        throw new Error(`market ${handle} uses ${strategy}: the base-price rule assumes INCLUDES_TAXES_IN_PRICE (no Belgian VAT deducted by Shopify); review before writing`);
      }
    }
  }
  const plans = planAll(live.variants, live.lists, rule);
  for (const l of plans) {
    console.log(`Shopify "${l.list.name}" (${l.name}): ${l.list.parent.adjustment.type} ${l.list.parent.adjustment.value} (fallback), ${l.fixed.size} fixed prices`);
    for (const p of l.plan) {
      const from = p.from ? `${p.from.price.toFixed(2)}${p.from.compareAt != null ? ` (was ${p.from.compareAt.toFixed(2)})` : ''}` : 'none';
      console.log(`  ${p.sku} ${p.title}: ${from} -> ${p.price.toFixed(2)}${p.compareAt != null ? ` (was ${p.compareAt.toFixed(2)})` : ''} ${l.currency}`);
    }
  }
  const differ = (usPlan ? 1 : 0) + plans.reduce((n, l) => n + l.plan.length, 0);
  if (!differ) {
    console.log('In sync: nothing to change.');
    return;
  }
  if (!apply) {
    console.log(`${differ} difference(s).${check ? '' : " Re-run with --apply to write them (founder's go: this changes prices)."}`);
    if (check) process.exit(1);
    return;
  }
  if (usPlan) {
    const r = (
      await admin(PRICE_LIST_UPDATE, {
        id: usPlan.id,
        input: {name: usPlan.name.to, parent: {adjustment: {type: 'PERCENTAGE_INCREASE', value: usPlan.to}}},
      })
    ).priceListUpdate;
    if (r.userErrors?.length) throw new Error(`US: ${r.userErrors.map((e) => e.message).join('; ')}`);
  }
  for (const l of plans) {
    if (!l.plan.length) continue;
    const r = (await admin(FIXED_ADD, {id: l.list.id, prices: fixedInput(l.plan, l.currency)})).priceListFixedPricesAdd;
    if (r.userErrors?.length) throw new Error(`${l.name}: ${r.userErrors.map((e) => e.message).join('; ')}`);
  }
  const again = await readLive(rule);
  const left = (planUplift(again.us, rule.priceUpliftPct) ? 1 : 0) + planAll(again.variants, again.lists, rule).reduce((n, l) => n + l.plan.length, 0);
  if (left) throw new Error(`read-back: ${left} difference(s) left`);
  console.log(`Done: ${differ} change(s) written and read back. Run the smoke test.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`us:prices: ${error.message}`);
    process.exit(1);
  });
}
