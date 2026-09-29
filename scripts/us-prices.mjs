#!/usr/bin/env node
// Compare the US price uplift in content/us-sales.json with the Shopify US
// price list, and with --apply write the file's value to the list.
//
//   npm run us:prices              dry run: prints both, changes nothing
//   npm run us:prices -- --apply   updates the price list adjustment and the
//                                  "(+N%)" suffix of its name
//
// The price list is the one for currency USD whose parent adjustment is a
// percentage increase (name "United States USD, duties included (+25%)").
// Prices are money: --apply needs the founder's go. Reads
// SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN and SHOPIFY_ADMIN_API_VERSION
// from the environment or .env (the token needs read_products and
// write_products). Nothing secret is printed.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_VERSION = '2026-07';

export const PRICE_LISTS_QUERY = `#graphql
  query OpenDroneUsPriceLists {
    priceLists(first: 50) {
      nodes { id name currency parent { adjustment { type value } } }
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

/** The name with its "(+N%)" suffix set to `pct`; appended when absent. */
export function nameWithUplift(name, pct) {
  const suffix = `(+${pct}%)`;
  return /\(\+[\d.]+%\)\s*$/.test(name) ? name.replace(/\(\+[\d.]+%\)\s*$/, suffix) : `${name} ${suffix}`;
}

/** The USD price list that is a percentage increase on the EUR price. */
export function findUsList(lists) {
  const matches = lists.filter(
    (l) => l.currency === 'USD' && l.parent?.adjustment?.type === 'PERCENTAGE_INCREASE',
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one USD PERCENTAGE_INCREASE price list, found ${matches.length}`);
  }
  return matches[0];
}

/** What the run would change, or null when Shopify already matches. */
export function planUplift(list, pct) {
  const live = Number(list.parent.adjustment.value);
  const name = nameWithUplift(list.name, pct);
  if (live === pct && name === list.name) return null;
  return {id: list.id, from: live, to: pct, name: {from: list.name, to: name}};
}

export function readUpliftPct(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8')).priceUpliftPct;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 300) {
    throw new Error('content/us-sales.json: priceUpliftPct must be a number from 0 to 300');
  }
  return value;
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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run us:prices [-- --apply]\nDry run by default; --apply writes content/us-sales.json priceUpliftPct to the Shopify US price list.');
    return;
  }
  const unknown = args.filter((a) => a !== '--apply');
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const apply = args.includes('--apply');
  loadDotenv();
  const pct = readUpliftPct(path.join(ROOT, 'content/us-sales.json'));
  const list = findUsList((await admin(PRICE_LISTS_QUERY)).priceLists.nodes);
  console.log(apply ? 'APPLY: updating the Shopify US price list.' : 'DRY RUN: nothing is changed.');
  console.log(`content/us-sales.json priceUpliftPct: +${pct}%`);
  console.log(`Shopify price list "${list.name}" (${list.id}): ${list.parent.adjustment.type} ${list.parent.adjustment.value}`);
  const plan = planUplift(list, pct);
  if (!plan) {
    console.log('In sync: nothing to change.');
    return;
  }
  console.log(`Difference: adjustment ${plan.from} -> ${plan.to}; name "${plan.name.from}" -> "${plan.name.to}"`);
  if (!apply) {
    console.log('Re-run with --apply to write it (needs the founder\'s go: this changes prices).');
    return;
  }
  const result = (
    await admin(PRICE_LIST_UPDATE, {
      id: plan.id,
      input: {name: plan.name.to, parent: {adjustment: {type: 'PERCENTAGE_INCREASE', value: plan.to}}},
    })
  ).priceListUpdate;
  if (result.userErrors?.length) throw new Error(result.userErrors.map((e) => e.message).join('; '));
  const back = findUsList((await admin(PRICE_LISTS_QUERY)).priceLists.nodes);
  console.log(`Read back: "${back.name}" ${back.parent.adjustment.type} ${back.parent.adjustment.value}`);
  if (planUplift(back, pct)) throw new Error('read-back does not match content/us-sales.json');
  console.log('Done. The storefront shows the new US prices on its next catalog read; run the smoke test.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`us:prices: ${error.message}`);
    process.exit(1);
  });
}
