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

import {READ_QUERY, FIXED_QUERY, FIXED_ADD, PRICE_LIST_UPDATE, parseRule, nameWithUplift, findUsList, planUplift, withEnding, intlPrice, ukPrice, findOtherLists, planFixedBy, fixedInput, planAll, readFixedLists, taxStrategyProblem} from '../app/lib/non-eu-prices.js';

export {READ_QUERY, FIXED_QUERY, FIXED_ADD, PRICE_LIST_UPDATE, parseRule, nameWithUplift, findUsList, planUplift, withEnding, intlPrice, ukPrice, findOtherLists, planFixedBy, fixedInput, planAll};

/** The validated rule of the committed file. */
export function readRule(file) {
  return parseRule(JSON.parse(fs.readFileSync(file, 'utf8')));
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
  const live = await readFixedLists(admin, rule);
  return {variants: live.variants, us: findUsList(live.priceLists), lists: live.lists, taxStrategies: live.taxStrategies};
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
  const taxProblem = live.lists.length ? taxStrategyProblem(live.taxStrategies) : null;
  if (taxProblem) throw new Error(`${taxProblem}: the base-price rule assumes INCLUDES_TAXES_IN_PRICE (no Belgian VAT deducted by Shopify); review before writing`);
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
