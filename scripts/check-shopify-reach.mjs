#!/usr/bin/env node
// Read-only: which destinations Shopify can sell to, against the site's list.
//
//   npm run check:reach
//
// Reads every Shopify market's countries and every delivery profile's zone
// countries (Admin API), then compares the countries in neither with
// NO_SHOPIFY_ROUTE in app/lib/shipping-rates.ts. Exits 1 when they differ, so
// a market or zone change in Shopify is mirrored in the same PR. Also prints
// each market and each profile with its zone count, for the region audit.
// Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN and
// SHOPIFY_ADMIN_API_VERSION from the environment or .env (read_markets,
// read_shipping). Never writes; prints nothing secret.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotenv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function admin(query) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  if (!domain || !token) throw new Error('SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_API_TOKEN are required');
  const version = process.env.SHOPIFY_ADMIN_API_VERSION?.trim() || '2026-07';
  const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
    body: JSON.stringify({query}),
  });
  const body = await response.json();
  if (!response.ok || body.errors) throw new Error(`Admin API: ${JSON.stringify(body.errors ?? response.status)}`);
  return body.data;
}

const MARKETS = `{ markets(first: 50) { nodes { handle status
  conditions { regionsCondition { regions(first: 250) { nodes { ... on MarketRegionCountry { code } } } } } } } }`;

const zonesQuery = (after) => `{ deliveryProfiles(first: 10) { nodes { name
  profileLocationGroups { locationGroupZones(first: 25${after ? `, after: "${after}"` : ''}) {
    pageInfo { hasNextPage endCursor } nodes { zone { countries { code { countryCode } } } } } } } } }`;

/** Countries named in NO_SHOPIFY_ROUTE, read from the source (no TS loader needed). */
function siteList() {
  const src = fs.readFileSync(path.join(ROOT, 'app/lib/shipping-rates.ts'), 'utf8');
  const block = src.match(/NO_SHOPIFY_ROUTE: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/);
  const destinations = src.match(/const DESTINATION_COUNTRIES = \(([\s\S]*?)\)\.split/);
  const codes = (text) => [...text.matchAll(/'([A-Z]{2})'/g)].map((m) => m[1]);
  const words = (text) => text.replace(/['+\s]+/g, ' ').trim().split(' ');
  return {listed: new Set(codes(block[1])), destinations: words(destinations[1])};
}

async function main() {
  loadDotenv();
  const markets = (await admin(MARKETS)).markets.nodes;
  const inMarket = new Set();
  for (const m of markets) {
    const codes = m.conditions?.regionsCondition?.regions?.nodes?.map((n) => n.code).filter(Boolean) ?? [];
    if (m.status === 'ACTIVE') codes.forEach((c) => inMarket.add(c));
    console.log(`market ${m.handle} ${m.status} ${codes.length} countries`);
  }
  const inZone = new Set();
  let after = null;
  for (;;) {
    const profiles = (await admin(zonesQuery(after))).deliveryProfiles.nodes;
    let next = null;
    for (const p of profiles) {
      for (const g of p.profileLocationGroups) {
        for (const z of g.locationGroupZones.nodes) z.zone.countries.forEach((c) => c.code.countryCode && inZone.add(c.code.countryCode));
        if (g.locationGroupZones.pageInfo.hasNextPage) next = g.locationGroupZones.pageInfo.endCursor;
      }
    }
    if (profiles.length > 1) console.log(`profiles: ${profiles.map((p) => p.name).join(', ')} (zones paged on the first only)`);
    if (!next) break;
    after = next;
  }
  const {listed, destinations} = siteList();
  const skip = new Set(['RU', 'BY', 'IR', 'KP', 'SY', 'CU', 'AQ', 'BV', 'HM', 'GS', 'TF', 'UM', 'IO']);
  const unreachable = destinations.filter((c) => !skip.has(c) && !(inMarket.has(c) && inZone.has(c)));
  const missing = unreachable.filter((c) => !listed.has(c));
  const stale = [...listed].filter((c) => !unreachable.includes(c));
  console.log(`unreachable in Shopify: ${unreachable.join(' ') || 'none'}`);
  if (missing.length) console.log(`add to NO_SHOPIFY_ROUTE: ${missing.join(' ')}`);
  if (stale.length) console.log(`remove from NO_SHOPIFY_ROUTE (Shopify now sells there): ${stale.join(' ')}`);
  process.exitCode = missing.length || stale.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
});
