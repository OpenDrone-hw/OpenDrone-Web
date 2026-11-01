#!/usr/bin/env node
// Move held preorder orders off paid-batch tags they no longer take.
//
//   node --experimental-strip-types scripts/retag-batches.mjs            (dry run)
//   node --experimental-strip-types scripts/retag-batches.mjs --apply
//
// Since 2026-11-01 paid stock goes only to orders whose every line ships with
// it (`shipsOnlyWithPaid`, app/lib/preorder-campaign.ts). The Worker writes
// `batch:SKU:N` tags once and never rewrites them, so an order tagged before
// that rule still carries `batch:OPENFC-LITE-3030:1` although its boards ship
// with the March batch. This removes such a paid-batch tag and adds the
// funding-batch tag the allocation now gives (`planRetag`). Only `preorder`
// orders whose fulfillment order is still on hold are touched; holds, other
// tags and orders already released or shipped are left alone.
//
// Options:
//   --apply     write the tags; without it this is a dry run
//   --help      print this help; reads and writes nothing
//
// Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN and
// SHOPIFY_ADMIN_API_VERSION from the environment or .env. The token needs
// read_orders and write_orders. Nothing secret is printed.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/** The dry-run report, one line per order. */
export function describePlans(plans) {
  const lines = [`Orders to retag: ${plans.length}`];
  for (const p of plans) lines.push(`  ${p.orderName}: remove ${p.remove.join(', ')}; add ${p.add.join(', ') || '-'}`);
  return lines;
}

function usage() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const lines = text.split('\n').slice(1);
  const end = lines.findIndex((l) => !l.startsWith('//'));
  return lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

async function loadLib() {
  try {
    return await import('../app/lib/preorder-fulfilment.ts');
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
  const preorders = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/preorders.json'), 'utf8'));
  const lib = await loadLib();
  const env = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ADMIN_API_TOKEN: process.env.SHOPIFY_ADMIN_API_TOKEN,
    SHOPIFY_ADMIN_API_VERSION: process.env.SHOPIFY_ADMIN_API_VERSION,
  };
  console.log(opts.apply ? 'APPLY: rewriting order tags.' : 'DRY RUN: nothing is changed.');
  const orders = await lib.fetchPreorderOrders(env, preorders.countFrom);
  const plans = lib.planRetag(orders, preorders);
  for (const line of describePlans(plans)) console.log(line);
  if (!opts.apply) {
    if (plans.length) console.log(`\nRun again with --apply to retag ${plans.length} order(s).`);
    return;
  }
  let failed = 0;
  for (const plan of plans) {
    try {
      for (const [mutation, tags, key] of [
        [lib.TAGS_ADD_MUTATION, plan.add, 'tagsAdd'],
        [lib.TAGS_REMOVE_MUTATION, plan.remove, 'tagsRemove'],
      ]) {
        if (!tags.length) continue;
        const data = await lib.adminGraphql(env, mutation, {id: plan.orderId, tags});
        const errors = data[key].userErrors;
        if (errors.length) throw new Error(errors[0].message);
      }
      console.log(`  ${plan.orderName}: retagged`);
    } catch (error) {
      failed += 1;
      console.log(`  ${plan.orderName}: failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(`\nRetagged ${plans.length - failed} order(s).`);
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`retag-batches: ${error.message}`);
    process.exit(1);
  });
}
