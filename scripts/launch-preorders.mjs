#!/usr/bin/env node
// Open preorders on production (opendrone.be), on the founder's go.
//
//   node scripts/launch-preorders.mjs            dry run: read-only checks and the plan
//   node scripts/launch-preorders.mjs --apply    perform every step, stop at the first failure
//
// Options: --pr <number> (default 489).
//
// The founder's own steps come first (README "Launch preorders"): payments,
// the redirect theme and the password page. This script does the rest:
//
//   1. Preflight: branch feat/preorders, a clean wrangler.production.toml,
//      the pull request open against main, the credentials present by name,
//      wrangler and gh signed in, and the Admin token's scopes (orders,
//      order tags, products, fulfillment holds).
//   2. Shopify prices: every campaign SKU in content/preorders.json is on
//      the storefront channel, has a compare-at (retail) price, and its
//      price equals the first price step (retail less priceTiers[0].off).
//   3. Worker secrets on opendrone-web, in one `wrangler secret bulk`:
//      SHOPIFY_PREVIEW_POLICY_JSON (the campaign SKUs as preorder, every
//      other storefront SKU sold_out), SHOPIFY_WEBHOOK_SECRET (from .env)
//      and SHOPIFY_PRICE_TIER_WRITE_ENABLED=1. Production stays closed:
//      its [vars] on main still say PUBLIC_COMING_SOON=1 and
//      SHOPIFY_CHECKOUT_WRITE_ENABLED=0.
//   4. Launch commit on feat/preorders: wrangler.production.toml [vars]
//      PUBLIC_COMING_SOON=0 and SHOPIFY_CHECKOUT_WRITE_ENABLED=1, pushed.
//   5. Wait for the pull request checks, then squash-merge it. This is the
//      production deploy.
//   6. Wait for the cloudflare-production workflow of the merge commit.
//   7. Register the ORDERS_PAID webhook with the Admin API token (the
//      OpenDrone Infra app, whose client secret signs it), unless it exists.
//   8. Flip the FC and ESC board repositories to status-beta (first
//      production batch). RX, frames and motors keep theirs.
//   9. Smoke production: scripts/smoke.mjs, the product feed sells every
//      campaign SKU, no staging noindex, the webhook refuses an unsigned
//      request (401) and accepts one signed with the local secret (200).
//
// Secret values are read from the environment or .env and passed to
// wrangler on stdin. They are never printed, logged or written to disk.

import {spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = 'feat/preorders';
const PROD_CONFIG = 'wrangler.production.toml';
const PROD_ORIGIN = 'https://opendrone.be';
const WEBHOOK_PATH = '/api/shopify/orders-paid';
const DEPLOY_WORKFLOW = 'cloudflare-production.yml';
const BETA_REPOS = ['OpenFC-Lite', 'OpenFC-Lite-Mini', 'OpenESC-20x20', 'OpenESC-30x30'];
const REQUIRED_ENV = [
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_STOREFRONT_TOKEN',
  'SHOPIFY_STOREFRONT_API_VERSION',
  'SHOPIFY_ADMIN_API_TOKEN',
  'SHOPIFY_ADMIN_API_VERSION',
  'SHOPIFY_WEBHOOK_SECRET',
];

// ---------------------------------------------------------------------------
// Pure parts (unit tested in app/lib/launch-preorders.test.ts)
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = {apply: false, pr: 489};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--dry-run') opts.apply = false;
    else if (arg === '--pr') {
      const n = Number(argv[(i += 1)]);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--pr needs a pull request number');
      opts.pr = n;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

/** The campaign SKUs, in content/preorders.json order. */
export function campaignSkus(preorders) {
  const skus = Object.keys(preorders?.skus ?? {});
  if (!skus.length) throw new Error('content/preorders.json lists no campaign SKUs');
  return skus;
}

/** Price of the first step, as the Worker computes it (tierPrice). */
export function firstStepPrice(retail, priceTiers) {
  const off = priceTiers?.[0]?.off;
  if (!Number.isFinite(retail) || !Number.isFinite(off)) return null;
  return Math.round(retail * (1 - off) * 100) / 100;
}

/**
 * Compare the storefront variants with the first price step. `variants` is
 * [{sku, price, compareAt}] with numbers (compareAt null when unset).
 * Returns one problem string per campaign SKU that is missing or mispriced.
 */
export function checkFirstStepPrices(variants, skus, priceTiers) {
  const bySku = new Map(variants.map((v) => [v.sku, v]));
  const problems = [];
  for (const sku of skus) {
    const v = bySku.get(sku);
    if (!v) {
      problems.push(`${sku}: not on the storefront channel`);
      continue;
    }
    if (v.compareAt == null) {
      problems.push(`${sku}: no compare-at (retail) price`);
      continue;
    }
    const expected = firstStepPrice(v.compareAt, priceTiers);
    if (expected == null || Math.abs(v.price - expected) > 0.005) {
      problems.push(`${sku}: price ${v.price.toFixed(2)}, first step is ${expected?.toFixed(2)} (retail ${v.compareAt.toFixed(2)})`);
    }
  }
  return problems;
}

/**
 * The production per-SKU policy (SHOPIFY_PREVIEW_POLICY_JSON): every
 * storefront SKU needs an entry or the catalog refuses to load. Campaign
 * SKUs sell as preorder with a null promise (the campaign sets the promise
 * per batch); every other SKU stays sold_out.
 */
export function buildLaunchPolicy(storefrontSkus, skus) {
  const present = new Set(storefrontSkus);
  const missing = skus.filter((sku) => !present.has(sku));
  if (missing.length) throw new Error(`campaign SKUs not on the storefront: ${missing.join(', ')}`);
  const campaign = new Set(skus);
  const policy = {};
  for (const sku of [...present].sort()) {
    policy[sku] = campaign.has(sku)
      ? {saleMode: 'preorder', shipPromise: null}
      : {saleMode: 'sold_out', shipPromise: null};
  }
  return policy;
}

/**
 * Set `key = "value"` pairs in the [vars] table of a wrangler TOML file.
 * Existing keys are rewritten in place; missing keys are appended to the
 * table. Everything outside [vars] is left byte for byte.
 */
export function setTomlVars(toml, values) {
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim() === '[vars]');
  if (start < 0) throw new Error('no [vars] table');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const pending = new Map(Object.entries(values));
  for (let i = start + 1; i < end; i += 1) {
    const m = lines[i].match(/^(\s*)([A-Z0-9_]+)(\s*=\s*)/);
    if (m && pending.has(m[2])) {
      lines[i] = `${m[1]}${m[2]}${m[3]}${JSON.stringify(pending.get(m[2]))}`;
      pending.delete(m[2]);
    }
  }
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  const added = [...pending].map(([k, v]) => `${k} = ${JSON.stringify(v)}`);
  lines.splice(insertAt, 0, ...added);
  return lines.join('\n');
}

/** Production [vars] that open the store. */
export function launchVars({prelaunchFlagInUse}) {
  return {
    SHOPIFY_CHECKOUT_WRITE_ENABLED: '1',
    PUBLIC_COMING_SOON: '0',
    ...(prelaunchFlagInUse ? {PUBLIC_PRELAUNCH: '0'} : null),
  };
}

/** Replace the closed-store comment above the vars once the store opens. */
export function launchComment(toml) {
  return toml.replace(
    /# Shopify catalog reads are active, while every commerce write remains closed\.\n# The domain, tokens, closed per-SKU policy and newsletter write switch are\n# configured separately by the reviewed runtime secret update\.\n/,
    '# Preorders are open: checkout writes on, coming-soon off. The domain,\n# tokens, per-SKU policy, webhook secret and price-step switch are Worker\n# secrets, set by scripts/launch-preorders.mjs.\n',
  );
}

/**
 * Admin API scopes the production Worker and the batch scripts use: the
 * paid counts, the price steps, the preorder holds and their order tags.
 */
export const REQUIRED_ADMIN_SCOPES = [
  'read_all_orders',
  'read_orders',
  'write_orders',
  'write_products',
  'write_merchant_managed_fulfillment_orders',
];

/** The required scopes missing from `granted` (handles, write implies read). */
export function missingAdminScopes(granted) {
  const have = new Set(granted);
  return REQUIRED_ADMIN_SCOPES.filter(
    (scope) => !have.has(scope) && !(scope.startsWith('read_') && have.has(scope.replace(/^read_/, 'write_'))),
  );
}

export const SCOPES_QUERY = `query { currentAppInstallation { accessScopes { handle } } }`;

export const WEBHOOK_LIST_QUERY = `query {
  webhookSubscriptions(first: 50, topics: [ORDERS_PAID]) { nodes { id topic uri } }
}`;

export const WEBHOOK_CREATE_MUTATION = `mutation Create($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`;

export function hasWebhook(nodes, uri) {
  return (nodes ?? []).some((n) => n.topic === 'ORDERS_PAID' && n.uri === uri);
}

/** Shopify's webhook signature: base64 HMAC-SHA256 of the raw body. */
export function shopifyHmac(secret, body) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

/** Campaign SKUs the production feed does not sell (unavailable or no price). */
export function unsoldInFeed(feed, skus) {
  const variants = new Map();
  for (const p of feed?.products ?? []) for (const v of p.variants ?? []) variants.set(v.sku, v);
  return skus.filter((sku) => {
    const v = variants.get(sku);
    return !v || v.available !== true || v.price == null;
  });
}

/** The step list printed by a dry run and followed by --apply. */
export function plan({pr, skus}) {
  return [
    ['preflight', `Check branch ${BRANCH}, a clean ${PROD_CONFIG}, PR #${pr} open against main, credentials present by name, wrangler and gh signed in, Admin token scopes (${REQUIRED_ADMIN_SCOPES.join(', ')}).`],
    ['prices', `Read the storefront catalog and check ${skus.length} campaign SKUs: each has a compare-at price and sells at the first price step.`],
    ['secrets', `npx wrangler secret bulk --config ${PROD_CONFIG} (stdin): SHOPIFY_PREVIEW_POLICY_JSON (${skus.length} SKUs preorder, the rest sold_out), SHOPIFY_WEBHOOK_SECRET (from .env), SHOPIFY_PRICE_TIER_WRITE_ENABLED=1. Production stays closed by its [vars].`],
    ['launch-commit', `Set ${PROD_CONFIG} [vars] PUBLIC_COMING_SOON="0", SHOPIFY_CHECKOUT_WRITE_ENABLED="1"; git commit; git push origin ${BRANCH}.`],
    ['merge', `gh pr checks ${pr} --watch, then gh pr merge ${pr} --squash --match-head-commit <launch commit>. This deploys production.`],
    ['deploy', `Wait for ${DEPLOY_WORKFLOW} on the merge commit: gh run watch --exit-status.`],
    ['webhook', `Admin API: webhookSubscriptionCreate(ORDERS_PAID, ${PROD_ORIGIN}${WEBHOOK_PATH}, JSON) unless it already exists.`],
    ['topics', `gh repo edit OpenDrone-hw/{${BETA_REPOS.join(',')}} --remove-topic status-alpha --add-topic status-beta.`],
    ['smoke', `BASE=${PROD_ORIGIN} node scripts/smoke.mjs; /products.json sells every campaign SKU; no noindex header; ${WEBHOOK_PATH} answers 401 unsigned and 200 signed.`],
  ];
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function sh(cmd, args, {input, inherit = false, allowFail = false} = {}) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', inherit ? 'inherit' : 'pipe', inherit ? 'inherit' : 'pipe'],
  });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.status})${res.stderr ? `: ${res.stderr.trim().slice(0, 400)}` : ''}`);
  }
  return {status: res.status, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim()};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function storefrontVariants() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const url = `https://${domain}/api/${process.env.SHOPIFY_STOREFRONT_API_VERSION}/graphql.json`;
  const query = `query { products(first: 100) { pageInfo { hasNextPage } nodes { handle variants(first: 100) { pageInfo { hasNextPage } nodes { sku price { amount currencyCode } compareAtPrice { amount } } } } } }`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN},
    body: JSON.stringify({query}),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`storefront read failed (HTTP ${res.status})`);
  const products = json.data.products;
  if (products.pageInfo.hasNextPage) throw new Error('storefront catalog exceeds one page');
  const variants = [];
  for (const p of products.nodes) {
    if (p.variants.pageInfo.hasNextPage) throw new Error(`${p.handle} has more than 100 variants`);
    for (const v of p.variants.nodes) {
      if (!v.sku) continue;
      if (v.price.currencyCode !== 'EUR') throw new Error(`${v.sku} is not priced in EUR`);
      variants.push({
        sku: v.sku.trim(),
        price: Number(v.price.amount),
        compareAt: v.compareAtPrice ? Number(v.compareAtPrice.amount) : null,
      });
    }
  }
  return variants;
}

async function admin(query, variables = {}) {
  const domain = process.env.SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const res = await fetch(`https://${domain}/admin/api/${process.env.SHOPIFY_ADMIN_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_API_TOKEN},
    body: JSON.stringify({query, variables}),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`Admin API failed (HTTP ${res.status}): ${JSON.stringify(json.errors ?? '').slice(0, 300)}`);
  return json.data;
}

function prelaunchFlagInUse() {
  const res = sh('git', ['grep', '-l', 'PUBLIC_PRELAUNCH', '--', 'app', 'server.ts'], {allowFail: true});
  return res.status === 0 && res.stdout.length > 0;
}

async function preflight(opts) {
  const problems = [];
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]?.trim());
  if (missing.length) problems.push(`missing credentials (by name): ${missing.join(', ')}`);
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {allowFail: true}).stdout;
  if (branch !== BRANCH) problems.push(`on branch ${branch || '?'}, need ${BRANCH}`);
  if (sh('git', ['status', '--porcelain', '--', PROD_CONFIG], {allowFail: true}).stdout) {
    problems.push(`${PROD_CONFIG} has uncommitted changes`);
  }
  const pr = sh('gh', ['pr', 'view', String(opts.pr), '--json', 'state,headRefName,baseRefName'], {allowFail: true});
  if (pr.status !== 0) problems.push(`gh cannot read PR #${opts.pr} (gh auth status?)`);
  else {
    const p = JSON.parse(pr.stdout);
    if (p.state !== 'OPEN' || p.headRefName !== BRANCH || p.baseRefName !== 'main') {
      problems.push(`PR #${opts.pr} is ${p.state} ${p.headRefName} -> ${p.baseRefName}`);
    }
  }
  if (sh('npx', ['wrangler', 'whoami'], {allowFail: true}).status !== 0) problems.push('wrangler is not signed in');
  if (!missing.length) {
    try {
      const data = await admin(SCOPES_QUERY);
      const gaps = missingAdminScopes(data.currentAppInstallation.accessScopes.map((s) => s.handle));
      if (gaps.length) problems.push(`Admin API token lacks scopes: ${gaps.join(', ')}`);
    } catch (error) {
      problems.push(`Admin API scope check failed: ${error.message}`);
    }
  }
  return problems;
}

async function smoke(skus) {
  const problems = [];
  // scripts/smoke.mjs reads BASE from the environment, set by the caller.
  const res = sh('node', ['scripts/smoke.mjs'], {allowFail: true, inherit: true});
  if (res.status !== 0) problems.push('scripts/smoke.mjs failed against production');
  const feedRes = await fetch(`${PROD_ORIGIN}/products.json`);
  if (!feedRes.ok) problems.push(`/products.json HTTP ${feedRes.status}`);
  else {
    const unsold = unsoldInFeed(await feedRes.json(), skus);
    if (unsold.length) problems.push(`not buyable in /products.json: ${unsold.join(', ')}`);
  }
  const home = await fetch(`${PROD_ORIGIN}/`);
  if ((home.headers.get('x-robots-tag') ?? '').includes('noindex')) problems.push('production sends noindex');
  const unsigned = await fetch(`${PROD_ORIGIN}${WEBHOOK_PATH}`, {method: 'POST', body: '{}'});
  if (unsigned.status !== 401) problems.push(`unsigned webhook answered ${unsigned.status}, expected 401`);
  const body = JSON.stringify({line_items: []});
  const signed = await fetch(`${PROD_ORIGIN}${WEBHOOK_PATH}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': shopifyHmac(process.env.SHOPIFY_WEBHOOK_SECRET, body)},
    body,
  });
  if (signed.status !== 200) problems.push(`signed webhook answered ${signed.status}, expected 200`);
  return problems;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  loadEnv();
  const preorders = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/preorders.json'), 'utf8'));
  const skus = campaignSkus(preorders);

  console.log(opts.apply ? 'APPLY: opening preorders on production.' : 'DRY RUN: nothing is written. Plan:');
  for (const [id, text] of plan({pr: opts.pr, skus})) console.log(`  [${id}] ${text}`);
  console.log('');

  const pre = await preflight(opts);
  for (const p of pre) console.log(`preflight: ${p}`);
  if (!pre.length) console.log('preflight: ok');

  let policy = null;
  if (REQUIRED_ENV.every((k) => process.env[k]?.trim())) {
    const variants = await storefrontVariants();
    const priceProblems = checkFirstStepPrices(variants, skus, preorders.priceTiers);
    for (const p of priceProblems) console.log(`prices: ${p}`);
    if (!priceProblems.length) console.log(`prices: ${skus.length} campaign SKUs at the first step`);
    pre.push(...priceProblems);
    policy = buildLaunchPolicy(variants.map((v) => v.sku), skus);
    const others = Object.keys(policy).length - skus.length;
    console.log(`policy: ${skus.length} SKUs preorder, ${others} sold_out`);
  }

  const vars = launchVars({prelaunchFlagInUse: prelaunchFlagInUse()});
  console.log(`launch vars: ${Object.entries(vars).map(([k, v]) => `${k}="${v}"`).join(' ')}`);

  if (pre.length) {
    console.log(`\n${pre.length} problem(s). ${opts.apply ? 'Nothing was changed.' : 'Fix them before --apply.'}`);
    process.exit(1);
  }
  if (!opts.apply) {
    console.log('\nReady. Run again with --apply on the founder\'s go.');
    return;
  }

  console.log('\n[secrets] wrangler secret bulk (values on stdin, not printed)');
  sh('npx', ['wrangler', 'secret', 'bulk', '--config', PROD_CONFIG], {
    input: JSON.stringify({
      SHOPIFY_PREVIEW_POLICY_JSON: JSON.stringify(policy),
      SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET.trim(),
      SHOPIFY_PRICE_TIER_WRITE_ENABLED: '1',
    }),
  });

  console.log('[launch-commit]');
  const tomlPath = path.join(ROOT, PROD_CONFIG);
  fs.writeFileSync(tomlPath, launchComment(setTomlVars(fs.readFileSync(tomlPath, 'utf8'), vars)));
  if (sh('git', ['status', '--porcelain', '--', PROD_CONFIG]).stdout) {
    sh('git', ['add', '--', PROD_CONFIG]);
    sh('git', ['commit', '-m', 'Open preorders on production\n\nPUBLIC_COMING_SOON=0 and SHOPIFY_CHECKOUT_WRITE_ENABLED=1 in the\nproduction [vars]. The per-SKU policy, webhook secret and price-step\nswitch were set as Worker secrets by scripts/launch-preorders.mjs.', '--', PROD_CONFIG]);
  } else {
    console.log('  launch vars already committed');
  }
  sh('git', ['push', 'origin', BRANCH], {inherit: true});
  const head = sh('git', ['rev-parse', 'HEAD']).stdout;

  console.log(`[merge] waiting for PR #${opts.pr} checks`);
  await sleep(15000);
  const checks = sh('gh', ['pr', 'checks', String(opts.pr), '--watch', '--fail-fast'], {allowFail: true, inherit: true});
  if (checks.status !== 0) {
    const again = sh('gh', ['pr', 'checks', String(opts.pr)], {allowFail: true});
    if (!/no checks reported/i.test(`${again.stdout} ${again.stderr}`)) throw new Error('PR checks failed; not merging');
  }
  sh('gh', ['pr', 'merge', String(opts.pr), '--squash', '--match-head-commit', head], {inherit: true});
  const merge = sh('gh', ['pr', 'view', String(opts.pr), '--json', 'mergeCommit', '-q', '.mergeCommit.oid']).stdout;

  console.log(`[deploy] waiting for ${DEPLOY_WORKFLOW} on ${merge.slice(0, 7)}`);
  let runId = '';
  for (let i = 0; i < 40 && !runId; i += 1) {
    await sleep(10000);
    runId = sh('gh', ['run', 'list', '--workflow', DEPLOY_WORKFLOW, '--commit', merge, '--json', 'databaseId', '-q', '.[0].databaseId'], {allowFail: true}).stdout;
  }
  if (!runId) throw new Error('no production deploy run found for the merge commit');
  sh('gh', ['run', 'watch', runId, '--exit-status'], {inherit: true});

  console.log('[webhook]');
  const uri = `${PROD_ORIGIN}${WEBHOOK_PATH}`;
  const existing = await admin(WEBHOOK_LIST_QUERY);
  if (hasWebhook(existing.webhookSubscriptions.nodes, uri)) console.log('  ORDERS_PAID already registered');
  else {
    const created = await admin(WEBHOOK_CREATE_MUTATION, {topic: 'ORDERS_PAID', webhookSubscription: {uri, format: 'JSON'}});
    const errs = created.webhookSubscriptionCreate.userErrors;
    if (errs.length) throw new Error(`webhookSubscriptionCreate: ${JSON.stringify(errs)}`);
    console.log(`  registered ${created.webhookSubscriptionCreate.webhookSubscription.id}`);
  }

  console.log('[topics]');
  for (const repo of BETA_REPOS) {
    sh('gh', ['repo', 'edit', `OpenDrone-hw/${repo}`, '--remove-topic', 'status-alpha', '--add-topic', 'status-beta']);
    console.log(`  ${repo}: status-beta`);
  }

  console.log('[smoke]');
  process.env.BASE = PROD_ORIGIN;
  delete process.env.SMOKE_AUTH;
  const problems = await smoke(skus);
  for (const p of problems) console.log(`  smoke: ${p}`);
  if (problems.length) process.exit(1);
  console.log('\nPreorders are open on production.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`launch-preorders: ${error.message}`);
    process.exit(1);
  });
}
