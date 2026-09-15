#!/usr/bin/env node
/**
 * Move the auto-mode financial goals in content/goals.json from the shop's
 * aggregate order totals.
 *
 * For each goal with `mode: "auto"`, takes the gross since the goal's
 * `since` date, applies the goal's `allocation_pct`, divides by
 * `target_eur`, and floors to 5% steps. The coarse rounding is the point:
 * the public meter stays "somewhere in this 5% band of an approximate
 * target" and never resolves to a revenue figure. Manual-mode goals are
 * never touched.
 *
 * Source: `GOALS_URL`, one GET per goal with a `since=YYYY-MM-DD` query,
 * answering
 *
 *   {"orders": 12, "revenue_eur": 842.5, "updated_at": "2026-09-14T10:00:00Z"}
 *
 * `revenue_eur` is the gross of non-cancelled orders since that date, in
 * EUR. Nothing else in the document is read, and no per-order detail is
 * requested: the script must never hold order-level data.
 *
 * This replaced a Shopify Admin API walk over `orders`. The Odoo endpoint
 * that serves the shape above is `GET /incutec/goals.json` (ERP PLAN.md
 * step 12.6, `erp PR #19`), live in production since 2026-09-14. GOALS_URL
 * itself is a repository secret consumed by the community-sync workflow
 * (`.github/workflows/community-sync.yml`) and this script reads it the
 * same way from a local `.env`; until that secret is set, leave GOALS_URL
 * unset and the script reports that and writes nothing.
 *
 * Mirrors computeAutoPct in app/lib/goals.ts (this script cannot import TS);
 * the unit test in app/lib/goals.test.ts greps this file to keep the formula
 * in step.
 *
 * Run:  npm run goals:update           (dry run, prints the result)
 *       npm run goals:update -- --write    (also writes content/goals.json)
 *
 * Env (repo .env or process env): GOALS_URL.
 *
 * The result is committed content: the community-sync workflow runs this
 * weekly and opens a PR, so the diff is always reviewed before it deploys.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOALS_FILE = path.join(ROOT, 'content', 'goals.json');
const AUTO_PCT_STEP = 5;

function loadEnv() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

const env = {...loadEnv(), ...process.env};
const WRITE = process.argv.includes('--write');

if (!env.GOALS_URL) {
  console.error(
    'GOALS_URL is not set. The Odoo aggregate endpoint it reads (ERP PLAN.md\n' +
      'step 12.6) is live at https://erp.incutec.eu/incutec/goals.json; set the\n' +
      'GOALS_URL repository secret (or a local .env) to activate this script.\n' +
      'Nothing was written.',
  );
  process.exit(1);
}

/**
 * Gross revenue in EUR since `since` (YYYY-MM-DD), from the aggregate
 * endpoint. Throws on anything but a well-formed document: a goal meter
 * silently reading 0% because the endpoint answered an error page would be
 * worse than a failed run.
 */
async function grossSince(since) {
  const url = new URL(env.GOALS_URL);
  url.searchParams.set('since', since);
  const res = await fetch(url, {headers: {Accept: 'application/json'}});
  if (!res.ok) throw new Error(`GOALS_URL HTTP ${res.status}`);
  const doc = await res.json();
  const gross = Number(doc?.revenue_eur);
  if (!Number.isFinite(gross)) {
    throw new Error('GOALS_URL: response has no numeric revenue_eur');
  }
  return gross;
}

// Mirror of computeAutoPct in app/lib/goals.ts.
function computeAutoPct(grossEur, goal) {
  if (goal.mode !== 'auto' || !goal.target_eur || goal.target_eur <= 0) {
    return null;
  }
  const counted = Math.max(0, grossEur) * (goal.allocation_pct / 100);
  const raw = (counted / goal.target_eur) * 100;
  return Math.min(100, Math.floor(raw / AUTO_PCT_STEP) * AUTO_PCT_STEP);
}

const doc = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
let changed = false;

for (const goal of doc.goals ?? []) {
  if (goal.mode !== 'auto') {
    console.error(`  ${goal.id}: manual, skipped`);
    continue;
  }
  if (!goal.since || !goal.target_eur) {
    console.error(`  ${goal.id}: auto but missing since/target_eur, skipped`);
    continue;
  }
  const gross = await grossSince(goal.since);
  const pct = computeAutoPct(gross, goal);
  if (pct === null) continue;
  console.error(
    `  ${goal.id}: ${pct}% (was ${goal.progress_pct}%)`,
  );
  if (pct !== goal.progress_pct) {
    goal.progress_pct = pct;
    changed = true;
  }
}

if (!changed) {
  console.error('no changes');
} else if (WRITE) {
  fs.writeFileSync(GOALS_FILE, `${JSON.stringify(doc, null, 2)}\n`);
  console.error(`wrote ${path.relative(ROOT, GOALS_FILE)}; review and commit it`);
} else {
  console.error('dry run; pass --write to update content/goals.json');
}
