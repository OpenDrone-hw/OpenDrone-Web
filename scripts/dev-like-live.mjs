#!/usr/bin/env node
// npm run dev:like-live: the dev server with the storefront settings production
// runs with, so localhost shows what opendrone.be shows (README "Run it locally").
//
// `npm run dev` drops every wrangler [vars] entry (vite.config.ts), so the
// Worker reads only `.env` and then `.env.local`, the later file winning. This
// script writes `.env.local` (git-ignored) and starts `react-router dev`:
//   - the display flags of wrangler.production.toml [vars] (DISPLAY_VARS);
//   - SHOPIFY_PREVIEW_POLICY_JSON rebuilt from content/preorders.json: every
//     campaign SKU and every shipsWith SKU `preorder` with `shipPromise: null`
//     (the campaign writes the promise and the Buy now lane), every other SKU
//     the `.env` policy names `sold_out`. The production value is a Worker
//     secret that cannot be read back; this is its documented shape.
//   - the safety overrides (SAFE): no Shopify cart, newsletter or support write.
//     LOCAL_SHOP_PREVIEW (dev server only, `shopShownOpen`) renders the open
//     shop: Buy, Pre-order, the availability bar and an empty /cart, as on the
//     live site. A click on Buy posts to the cart action, which answers 404
//     "Shopify checkout writes are not enabled.", so no cart, checkout or order
//     can be created from localhost.
// Delete `.env.local` to go back to the `.env` defaults. Values are never printed.
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseEnv} from 'node:util';

const root = process.cwd();
const DISPLAY_VARS = [
  'PUBLIC_COMING_SOON',
  'PUBLIC_US_SALES',
  'BATCH_CHOICE',
  'ACCOUNTS_ENABLED',
  'TRADE_MAIL_ENABLED',
  'PILOT_MAP_ENABLED',
  'CHATFPV_URL',
  'CHATFPV_WIDGET_ENABLED',
  'HANDOFF_ENABLED',
];
const SAFE = {
  SHOPIFY_CHECKOUT_WRITE_ENABLED: '0',
  SHOPIFY_NEWSLETTER_WRITE_ENABLED: '0',
  SHOPIFY_PRICE_TIER_WRITE_ENABLED: '0',
  SUPPORT_SHOPIFY_WRITE_ENABLED: '0',
  SUPPORT_EMAIL_NOTIFY_ENABLED: '0',
  SUPPORT_MAIL_INTAKE_ENABLED: '0',
  OPS_ALERTS_ENABLED: '0',
  // Shows the open shop (Buy, Pre-order, cart drawer) while the gate above stays shut.
  LOCAL_SHOP_PREVIEW: '1',
};

function productionVars() {
  const vars = {};
  let inVars = false;
  for (const line of readFileSync(join(root, 'wrangler.production.toml'), 'utf8').split('\n')) {
    const section = line.match(/^\s*\[\[?([^\]]+)\]?\]\s*$/);
    if (section) { inVars = section[1].trim() === 'vars'; continue; }
    const kv = inVars && line.match(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    if (kv) vars[kv[1]] = kv[2];
  }
  return vars;
}

function policy(envPolicy) {
  const campaign = JSON.parse(readFileSync(join(root, 'content/preorders.json'), 'utf8'));
  const selling = new Set([...Object.keys(campaign.skus ?? {}), ...Object.keys(campaign.shipsWith ?? {})]);
  const out = {};
  for (const sku of Object.keys(envPolicy)) out[sku] = {saleMode: 'sold_out', shipPromise: null};
  for (const sku of selling) out[sku] = {saleMode: 'preorder', shipPromise: null};
  return out;
}

const envPath = join(root, '.env');
if (!existsSync(envPath)) {
  console.error('dev:like-live: no .env; create it first (README "Run it locally").');
  process.exit(1);
}
const env = parseEnv(readFileSync(envPath, 'utf8'));
let envPolicy = {};
try { envPolicy = JSON.parse(env.SHOPIFY_PREVIEW_POLICY_JSON ?? '{}'); } catch {
  console.error('dev:like-live: SHOPIFY_PREVIEW_POLICY_JSON in .env is not JSON.');
  process.exit(1);
}
const prod = productionVars();
const missing = DISPLAY_VARS.filter((name) => !(name in prod));
if (missing.length) console.warn(`dev:like-live: not in wrangler.production.toml [vars], left unset: ${missing.join(', ')}`);
const lines = [
  '# Written by scripts/dev-like-live.mjs (npm run dev:like-live). Overrides .env; delete this file to undo.',
  ...DISPLAY_VARS.filter((name) => name in prod).map((name) => `${name}=${JSON.stringify(prod[name])}`),
  ...Object.entries(SAFE).map(([name, value]) => `${name}=${JSON.stringify(value)}`),
  `SHOPIFY_PREVIEW_POLICY_JSON='${JSON.stringify(policy(envPolicy))}'`,
];
writeFileSync(join(root, '.env.local'), lines.join('\n') + '\n');
process.stdout.write('dev:like-live: wrote .env.local (production display flags, rebuilt SKU policy, writes off)\n');

if (process.argv.includes('--write-only')) process.exit(0);
const child = spawn('npx', ['react-router', 'dev', ...process.argv.slice(2)], {stdio: 'inherit'});
child.on('exit', (code) => process.exit(code ?? 0));
