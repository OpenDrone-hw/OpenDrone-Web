#!/usr/bin/env node
// Paid orders since a date, grouped by creator ref and by utm_source.
// Read only: it never writes to Shopify or anywhere else.
//
//   node --experimental-strip-types scripts/attribution-report.mjs --since 2026-09-25
//   node --experimental-strip-types scripts/attribution-report.mjs --since 2026-09-25 --orders
//   node --experimental-strip-types scripts/attribution-report.mjs --since 2026-09-28 --until 2026-10-04 --json
//
// Options:
//   --since YYYY-MM-DD  first order day to include (required)
//   --until YYYY-MM-DD  last order day to include (default: no end)
//   --orders            also list every counted order with its attribution
//   --json              print the totals, the groups (by ref, by utm_source,
//                       by shipping country) and the counted orders as JSON,
//                       without order names; for scheduled reviews
//   --help              print this help; reads and writes nothing
//
// An order counts when it is not a test, not cancelled, and its financial
// status is PAID or PARTIALLY_REFUNDED. Units are the current line
// quantities (refunded units removed). Revenue is the order's current
// total in shop currency: VAT and shipping included, refunds removed.
//
// Attribution comes from the order's note attributes `_ref`,
// `_utm_source`, `_utm_medium`, `_utm_campaign` and `_landing`, written as
// cart attributes at the visitor's first add to cart in a browser session
// (README, "Analytics and attribution"). An order without them shows as
// `(none)` / `(direct)`: a direct visit, a visit without JavaScript, or a
// cart filled in another browser session. Country is the order's shipping
// country code, `(none)` without a shipping address.
//
// Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN and
// SHOPIFY_ADMIN_API_VERSION from the environment or .env. The token needs
// read_orders. Nothing secret is printed.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ORDERS_QUERY = `#graphql
  query OpenDroneAttributionOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        createdAt
        test
        cancelledAt
        displayFinancialStatus
        customAttributes { key value }
        shippingAddress { countryCodeV2 }
        currentTotalPriceSet { shopMoney { amount currencyCode } }
        lineItems(first: 250) {
          pageInfo { hasNextPage }
          nodes { sku currentQuantity }
        }
      }
    }
  }
`;

const COUNTED = new Set(['PAID', 'PARTIALLY_REFUNDED']);
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

// ---------------------------------------------------------------------------
// Pure parts (unit tested in app/lib/growth/attribution-report.test.ts)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {since: null, until: null, orders: false, json: false, help: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return {...opts, help: true};
    if (arg === '--orders') opts.orders = true;
    else if (arg === '--json') opts.json = true;
    else if (/^--(since|until)(=|$)/.test(arg)) {
      const name = arg.slice(2).split('=')[0];
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
        throw new Error(`--${name} needs a date as YYYY-MM-DD`);
      }
      opts[name] = value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.help && !opts.since) throw new Error('--since YYYY-MM-DD is required');
  if (opts.until && opts.until < opts.since) throw new Error('--until is before --since');
  return opts;
}

/** One counted order as the report sees it, or null when it does not count. */
export function orderRow(node) {
  if (!node || node.test || node.cancelledAt || !COUNTED.has(node.displayFinancialStatus)) return null;
  if (node.lineItems?.pageInfo?.hasNextPage) throw new Error(`order ${node.name} has more than 250 lines`);
  const attr = (key) => {
    const value = (node.customAttributes ?? []).find((a) => a.key === key)?.value?.trim();
    return value || null;
  };
  const units = {};
  for (const line of node.lineItems?.nodes ?? []) {
    const sku = line.sku?.trim() || '(no sku)';
    if (line.currentQuantity > 0) units[sku] = (units[sku] ?? 0) + line.currentQuantity;
  }
  const money = node.currentTotalPriceSet?.shopMoney;
  return {
    name: node.name,
    createdAt: node.createdAt,
    ref: attr('_ref'),
    source: attr('_utm_source'),
    medium: attr('_utm_medium'),
    campaign: attr('_utm_campaign'),
    landing: attr('_landing'),
    country: node.shippingAddress?.countryCodeV2 || null,
    units,
    revenue: Number(money?.amount ?? 0),
    currency: money?.currencyCode ?? '',
  };
}

/** Rows grouped by `keyOf(row)`: orders, units per SKU and revenue. */
export function groupRows(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? {key, orders: 0, units: {}, revenue: 0};
    group.orders += 1;
    group.revenue += row.revenue;
    for (const [sku, n] of Object.entries(row.units)) group.units[sku] = (group.units[sku] ?? 0) + n;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.revenue - a.revenue || a.key.localeCompare(b.key));
}

export const byRef = (row) => row.ref ?? '(none)';
export const bySource = (row) => row.source ?? (row.ref ? `(ref only)` : '(direct)');
export const byCountry = (row) => row.country ?? '(none)';

/** The `created_at` search for the date range; `until` is the last day included. */
export function ordersSearch(since, until) {
  if (!until) return `created_at:>=${since}`;
  const next = new Date(Date.parse(`${until}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `created_at:>=${since} created_at:<${next}`;
}

/** The machine-readable report: totals, groups and counted orders without names. */
export function jsonReport(rows, {since, until, seen, currency}) {
  const revenue = rows.reduce((n, r) => n + r.revenue, 0);
  return {
    since,
    until,
    currency,
    read: seen,
    orders: rows.length,
    revenue: Math.round(revenue * 100) / 100,
    attributed: rows.filter((r) => r.ref || r.source || r.medium || r.campaign).length,
    byRef: groupRows(rows, byRef),
    bySource: groupRows(rows, bySource),
    byCountry: groupRows(rows, byCountry),
    rows: rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'name'))),
  };
}

/** A plain-text table for one grouping. */
export function formatGroups(title, groups, currency) {
  const lines = [`${title}`];
  if (!groups.length) return [...lines, '  (no orders)'].join('\n');
  const width = Math.max(...groups.map((g) => g.key.length), 8);
  lines.push(`  ${'group'.padEnd(width)}  orders  ${`revenue ${currency}`.padStart(14)}  units per SKU`);
  for (const g of groups) {
    const units = Object.entries(g.units).sort(([a], [b]) => a.localeCompare(b)).map(([sku, n]) => `${sku} x${n}`).join(', ');
    lines.push(`  ${g.key.padEnd(width)}  ${String(g.orders).padStart(6)}  ${g.revenue.toFixed(2).padStart(14)}  ${units || '-'}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

function usage() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  const end = lines.findIndex((l) => !l.startsWith('//'));
  return lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
  let fulfilment;
  try {
    fulfilment = await import('../app/lib/preorder-fulfilment.ts');
  } catch (error) {
    if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new Error('run with node --experimental-strip-types (Node 22) or Node 23.6+');
    }
    throw error;
  }
  const env = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ADMIN_API_TOKEN: process.env.SHOPIFY_ADMIN_API_TOKEN,
    SHOPIFY_ADMIN_API_VERSION: process.env.SHOPIFY_ADMIN_API_VERSION,
  };
  const rows = [];
  let seen = 0;
  let after = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} orders; narrow --since`);
    const data = await fulfilment.adminGraphql(env, ORDERS_QUERY, {first: PAGE_SIZE, after, query: ordersSearch(opts.since, opts.until)});
    for (const node of data.orders.nodes) {
      seen += 1;
      const row = orderRow(node);
      if (row) rows.push(row);
    }
    if (!data.orders.pageInfo.hasNextPage) break;
    after = data.orders.pageInfo.endCursor;
  }
  const currencies = [...new Set(rows.map((r) => r.currency).filter(Boolean))];
  if (currencies.length > 1) throw new Error(`orders use more than one shop currency: ${currencies.join(', ')}`);
  const currency = currencies[0] ?? '';
  if (opts.json) {
    console.log(JSON.stringify(jsonReport(rows, {since: opts.since, until: opts.until, seen, currency}), null, 2));
    return;
  }
  const total = rows.reduce((n, r) => n + r.revenue, 0);
  const range = opts.until ? `from ${opts.since} to ${opts.until}` : `on or after ${opts.since}`;
  console.log(`READ ONLY. Orders created ${range}: ${seen} read, ${rows.length} paid and counted, revenue ${total.toFixed(2)} ${currency}.`);
  const attributed = rows.filter((r) => r.ref || r.source || r.medium || r.campaign).length;
  console.log(`${attributed} of ${rows.length} counted orders carry attribution.\n`);
  console.log(formatGroups('By creator ref (_ref):', groupRows(rows, byRef), currency));
  console.log('');
  console.log(formatGroups('By utm_source (_utm_source):', groupRows(rows, bySource), currency));
  if (opts.orders) {
    console.log('\nOrders:');
    for (const r of rows) {
      const units = Object.entries(r.units).map(([sku, n]) => `${sku} x${n}`).join(', ');
      const tags = [
        r.ref && `ref=${r.ref}`,
        r.source && `source=${r.source}`,
        r.medium && `medium=${r.medium}`,
        r.campaign && `campaign=${r.campaign}`,
        r.landing && `landing=${r.landing}`,
      ].filter(Boolean).join(' ');
      console.log(`  ${r.name}  ${r.createdAt.slice(0, 10)}  ${r.revenue.toFixed(2)} ${r.currency}  ${units}  ${tags || '(no attribution)'}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`attribution-report: ${error.message}`);
    process.exit(1);
  });
}
