#!/usr/bin/env node
// Close the funding-target preorders in Shopify once the run ends (`endsOn`).
//
//   node --experimental-strip-types scripts/close-preorder-run.mjs
//   node --experimental-strip-types scripts/close-preorder-run.mjs --apply
//
// Options:
//   --apply          set the listed variants' inventory policy to DENY;
//                    without it this is a dry run. Refused before the end of
//                    `endsOn` (Europe/Brussels).
//   --help           print this help; reads and writes nothing
//
// The storefront closes a SKU whose next unit waits for a funding target
// once `endsOn` has passed, but nothing changes in Shopify: an old checkout
// link or an abandoned-checkout recovery mail can still complete an order.
// This lists every campaign SKU (and every `shipsWith` SKU) whose next EU
// unit waits for a funding target, with its Shopify inventory policy, and
// with --apply sets each CONTINUE variant to DENY. DENY stops a sale only
// while the variant tracks inventory at 0 or less: the dry run names any
// variant that is not tracked or has stock, which stays sellable.
//
// A SKU whose next EU unit still comes from paid stock or a dated batch
// keeps selling and is listed as kept. Its non-EU units wait for a funding
// target: the storefront refuses them, Shopify does not.
//
// Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN and
// SHOPIFY_ADMIN_API_VERSION from the environment or .env. The token needs
// read_orders, read_products and, for --apply, write_products. Nothing
// secret is printed. Changing an inventory policy needs the founder's go.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VARIANTS_QUERY = `#graphql
  query OpenDroneCloseRunVariants($first: Int!, $query: String!) {
    productVariants(first: $first, query: $query) {
      nodes { id sku inventoryPolicy inventoryQuantity inventoryItem { tracked } product { id } }
    }
  }
`;

export const DENY_MUTATION = `#graphql
  mutation OpenDroneCloseRunDeny($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      userErrors { field message }
    }
  }
`;

// ---------------------------------------------------------------------------
// Pure parts (unit tested in app/lib/preorder-close.test.ts)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {apply: false, help: false};
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return {...opts, help: true};
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/**
 * Which SKUs close: `close` waits for a funding target on its next EU unit,
 * `keep` still sells from paid stock or a dated batch. `campaign` is
 * `app/lib/preorder-campaign.ts`; `units` is its paid unit runs per SKU.
 */
export function planClose(campaign, config, units) {
  const close = [];
  const keep = [];
  for (const [sku, entry] of Object.entries(config.skus)) {
    const state = campaign.campaignState(entry.batches, units[sku] ?? 0, config.pendingShips, campaign.tiersFor(config, sku), null, 'EU');
    (state.shipsOnTarget && !state.paidStock ? close : keep).push(sku);
  }
  for (const [sku, rule] of Object.entries(config.shipsWith ?? {})) {
    if (!config.skus[rule.sku]) continue;
    const state = campaign.shipsWithState(config, rule, units[rule.sku] ?? 0, null, units[sku] ?? 0, 'EU');
    (state.shipsOnTarget ? close : keep).push(sku);
  }
  return {close, keep};
}

/** The writes for the variants of SKUs that close, grouped by product, and
 *  what the dry run reports per SKU. */
export function planDeny(close, variants) {
  const bySku = new Map(variants.filter((v) => v.sku).map((v) => [v.sku.trim(), v]));
  const writes = new Map();
  const lines = [];
  for (const sku of close) {
    const v = bySku.get(sku);
    if (!v) {
      lines.push(`  ${sku}: not in Shopify`);
      continue;
    }
    const notes = [];
    if (!v.inventoryItem?.tracked) notes.push('inventory not tracked: DENY does not stop a sale');
    else if ((v.inventoryQuantity ?? 0) > 0) notes.push(`${v.inventoryQuantity} in stock: DENY still sells them`);
    if (v.inventoryPolicy === 'DENY') {
      lines.push(`  ${sku}: already DENY${notes.length ? `, ${notes.join(', ')}` : ''}`);
      continue;
    }
    lines.push(`  ${sku}: ${v.inventoryPolicy} -> DENY${notes.length ? `, ${notes.join(', ')}` : ''}`);
    const list = writes.get(v.product.id) ?? [];
    list.push({id: v.id, inventoryPolicy: 'DENY'});
    writes.set(v.product.id, list);
  }
  return {writes: [...writes].map(([productId, list]) => ({productId, variants: list})), lines};
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

function usage() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  const end = lines.findIndex((l) => !l.startsWith('//'));
  return lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

async function loadLibs() {
  try {
    return {
      campaign: await import('../app/lib/preorder-campaign.ts'),
      orders: await import('../app/lib/shopify-orders.ts'),
      fulfilment: await import('../app/lib/preorder-fulfilment.ts'),
    };
  } catch (error) {
    if (error?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
      throw new Error('run with node --experimental-strip-types (Node 22) or Node 23.6+');
    }
    throw error;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
  const {campaign, orders, fulfilment} = await loadLibs();
  const config = campaign.parseCampaignConfig(JSON.parse(fs.readFileSync(path.join(ROOT, 'content/preorders.json'), 'utf8')));
  const ended = campaign.fundingClosed(config);
  if (opts.apply && !ended) throw new Error(`the run ends at the end of ${config.endsOn} (Europe/Brussels); --apply is refused before then`);
  const env = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ADMIN_API_TOKEN: process.env.SHOPIFY_ADMIN_API_TOKEN,
    SHOPIFY_ADMIN_API_VERSION: process.env.SHOPIFY_ADMIN_API_VERSION,
  };

  console.log(opts.apply ? 'APPLY: setting inventory policy DENY.' : 'DRY RUN: nothing is changed.');
  if (!ended) console.log(`The run is still open until the end of ${config.endsOn}; this is what would close now.`);
  const units = await orders.fetchPaidUnitRuns(env, config.countFrom, campaign.countedSkus(config));
  const {close, keep} = planClose(campaign, config, units);
  const skus = [...close];
  const variants = [];
  for (let i = 0; i < skus.length; i += 50) {
    const query = skus.slice(i, i + 50).map((s) => `sku:'${s.replace(/'/g, '')}'`).join(' OR ');
    const data = await fulfilment.adminGraphql(env, VARIANTS_QUERY, {first: 100, query});
    variants.push(...data.productVariants.nodes);
  }
  const {writes, lines} = planDeny(close, variants);
  console.log(`Close (${close.length}):`);
  for (const line of lines) console.log(line);
  console.log(`Kept, still selling paid stock or a dated batch in the EU (${keep.length}): ${keep.join(', ') || '-'}`);
  if (!opts.apply) {
    if (writes.length) console.log(`\nAfter ${config.endsOn}, run again with --apply to write ${writes.reduce((n, w) => n + w.variants.length, 0)} variant(s).`);
    return;
  }
  let failed = 0;
  for (const write of writes) {
    const data = await fulfilment.adminGraphql(env, DENY_MUTATION, write);
    const errors = data.productVariantsBulkUpdate.userErrors;
    if (errors.length) {
      failed += 1;
      console.log(`  ${write.productId}: not written: ${errors[0].message}`);
    }
  }
  console.log(`\nWrote ${writes.length - failed} product(s). Check the product pages and /api/status/campaign.`);
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`close-preorder-run: ${error.message}`);
    process.exit(1);
  });
}
