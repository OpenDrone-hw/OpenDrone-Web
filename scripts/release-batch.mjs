#!/usr/bin/env node
// Release the held preorder orders of one batch so they can be shipped.
//
//   node --experimental-strip-types scripts/release-batch.mjs --sku OPENFC-LITE-2020
//   node --experimental-strip-types scripts/release-batch.mjs --sku OPENFC-LITE-2020 --batch 1 --apply
//
// Options:
//   --sku SKU        campaign SKU from content/preorders.json (required)
//   --batch N        batch number, default 1
//   --with SKU:N     another batch that is also ready, or settled (its item
//                    refunded or the buyer chose to wait); repeat or comma-separate
//   --apply          release the holds; without it this is a dry run
//   --help           print this help; reads and writes nothing
//
// A paid preorder order is held by the Worker (app/lib/preorder-fulfilment.ts)
// and tagged `batch:SKU:N` for every batch its units fall into. A held order
// is in the batches the campaign allocation gives it now (`orderBatchesNow`:
// an order tagged before the March rule keeps a stale paid-batch tag); an
// eu-stock order, or one the allocation does not cover, by its tags. An order
// ships as one parcel (terms 7bis.5), so this releases an order only when
// every batch it carries is the requested one or named with --with, and no
// fulfillment order carries a hold of another handle (placed in admin or by
// another app: release that one there). The dry run lists every held order
// of the batch: the ones that ship now and the ones that still wait, with
// what they wait for, and warns about any batch that holds more units than
// it has.
//
// --apply releases order by order: one that fails does not stop the others,
// and the end lists the released and the failed orders. A released order's
// "Fulfill by" moves from the March ship-by date it had while held to its
// batch's promise: a few working days for paid stock.
//
// After --apply, the released orders are open for fulfilment: import them in
// the bpost plugin and print the labels (docs/selling.md "Fulfil a batch").
//
// Reads SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_API_TOKEN and
// SHOPIFY_ADMIN_API_VERSION from the environment or .env. The token needs
// read_orders and write_merchant_managed_fulfillment_orders. Nothing secret
// is printed.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Pure parts (unit tested in app/lib/preorder-notify.test.ts)
// ---------------------------------------------------------------------------

export function parseArgs(argv, campaignSkus) {
  const opts = {sku: null, batch: 1, with: [], apply: false, help: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return {...opts, help: true};
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--sku') opts.sku = String(argv[(i += 1)] ?? '').trim();
    else if (arg === '--batch') {
      const n = Number(argv[(i += 1)]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--batch needs a whole number from 1');
      opts.batch = n;
    } else if (arg === '--with') {
      for (const part of String(argv[(i += 1)] ?? '').split(',')) {
        const m = /^([A-Za-z0-9-]+):(\d+)$/.exec(part.trim());
        if (!m) throw new Error(`--with needs SKU:N, got "${part}"`);
        if (!campaignSkus.includes(m[1])) throw new Error(`--with: ${m[1]} is not a campaign SKU`);
        opts.with.push(`batch:${m[1]}:${Number(m[2])}`);
      }
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.sku) throw new Error('--sku is required');
  if (!campaignSkus.includes(opts.sku)) {
    throw new Error(`${opts.sku} is not a campaign SKU (${campaignSkus.join(', ')})`);
  }
  return opts;
}

/** Warnings for batches holding more units than they have (`overfullBatches`). */
export function describeOverfull(overfull) {
  return overfull.map(
    (b) => `Warning: ${b.sku} batch ${b.batch} has ${b.units} units but its orders carry ${b.tagged}. Settle the extra orders by hand before releasing it.`,
  );
}

/** The closing report of an --apply run. */
export function describeApply(released, failed) {
  const lines = [`Released (${released.length}): ${released.join(', ') || '-'}`];
  if (failed.length) {
    lines.push(`Failed (${failed.length}), still held; run again to retry:`);
    for (const f of failed) lines.push(`  ${f.orderName}: ${f.error}`);
  }
  return lines;
}

/** The dry-run report, one line per order. */
export function describePlans(plans, {sku, batch}) {
  const ships = plans.filter((p) => !p.waitsFor.length);
  const waits = plans.filter((p) => p.waitsFor.length);
  const lines = [`Held orders in ${sku} batch ${batch}: ${plans.length}`];
  lines.push(`  ships now (${ships.length}): ${ships.map((p) => p.orderName).join(', ') || '-'}`);
  if (waits.length) {
    lines.push(`  still waits (${waits.length}):`);
    for (const p of waits) lines.push(`    ${p.orderName} waits for ${p.waitsFor.join(', ')}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

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

function usage() {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const lines = text.split('\n').slice(1);
  const end = lines.findIndex((l) => !l.startsWith('//'));
  return lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

async function main() {
  const preorders = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/preorders.json'), 'utf8'));
  const opts = parseArgs(process.argv.slice(2), Object.keys(preorders.skus ?? {}));
  if (opts.help) {
    console.log(usage());
    return;
  }
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
  const lib = await loadLib();
  const env = {
    SHOPIFY_STORE_DOMAIN: process.env.SHOPIFY_STORE_DOMAIN,
    SHOPIFY_ADMIN_API_TOKEN: process.env.SHOPIFY_ADMIN_API_TOKEN,
    SHOPIFY_ADMIN_API_VERSION: process.env.SHOPIFY_ADMIN_API_VERSION,
  };

  console.log(opts.apply ? 'APPLY: releasing holds.' : 'DRY RUN: nothing is changed.');
  const orders = await lib.fetchPreorderOrders(env, preorders.countFrom);
  const untagged = lib.planPreorderHolds(orders, preorders);
  if (untagged.length) {
    console.log(
      `Warning: ${untagged.length} paid preorder order(s) are not held or tagged yet (${untagged
        .map((p) => p.orderName)
        .join(', ')}). The Worker reconcile does that every five minutes; check /api/status/campaign.`,
    );
  }
  for (const line of describeOverfull(lib.overfullBatches(orders, preorders))) console.log(line);
  const allocated = lib.assignBatches(orders, preorders);
  const plans = lib.planRelease(orders, opts.sku, opts.batch, new Set(opts.with), preorders.shipsWith ?? {}, preorders.usStock, allocated);
  for (const line of describePlans(plans, opts)) console.log(line);

  const ready = plans.filter((p) => !p.waitsFor.length);
  if (!opts.apply) {
    const deadlines = lib.planReleaseDeadlines(orders, ready, preorders, opts.sku, opts.batch, new Date());
    for (const {deadline, ids} of deadlines) console.log(`  Fulfill by on release: ${ids.length} fulfillment order(s) to ${deadline.slice(0, 10)}`);
    if (ready.length) console.log(`\nRun again with --apply to release ${ready.length} order(s).`);
    return;
  }
  const released = [];
  const failed = [];
  for (const plan of ready) {
    try {
      for (const fo of plan.release) {
        const data = await lib.adminGraphql(env, lib.RELEASE_MUTATION, {id: fo.id, holdIds: fo.holdIds});
        const errors = data.fulfillmentOrderReleaseHold.userErrors;
        if (errors.length) throw new Error(errors[0].message);
      }
      released.push(plan);
      console.log(`  ${plan.orderName}: released`);
    } catch (error) {
      failed.push({orderName: plan.orderName, error: String(error?.message ?? error).slice(0, 200)});
      console.log(`  ${plan.orderName}: not released: ${failed.at(-1).error}`);
    }
  }
  // Released orders lose the March "Fulfill by" they had while held.
  const deadlineFailed = [];
  for (const {deadline, ids} of lib.planReleaseDeadlines(orders, released, preorders, opts.sku, opts.batch, new Date())) {
    for (let i = 0; i < ids.length; i += lib.DEADLINE_CHUNK) {
      try {
        const data = await lib.adminGraphql(env, lib.DEADLINE_MUTATION, {ids: ids.slice(i, i + lib.DEADLINE_CHUNK), deadline});
        const errors = data.fulfillmentOrdersSetFulfillmentDeadline.userErrors;
        if (errors.length) throw new Error(errors[0].message);
      } catch (error) {
        deadlineFailed.push(`${deadline.slice(0, 10)}: ${String(error?.message ?? error).slice(0, 200)}`);
      }
    }
  }
  console.log('');
  for (const line of describeApply(released.map((p) => p.orderName), failed)) console.log(line);
  for (const line of deadlineFailed) console.log(`Fulfill by not reset (set it in Shopify admin): ${line}`);
  if (released.length) console.log('Next: import the released orders in the bpost plugin and print the labels.');
  if (failed.length || deadlineFailed.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`release-batch: ${error.message}`);
    process.exit(1);
  });
}
