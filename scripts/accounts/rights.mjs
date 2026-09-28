#!/usr/bin/env node
// Founder erase and export of one Shopify customer's shared-account data
// (opendrone.be account rows and ChatFPV history), for an email request
// answered within one month (GDPR Art 12(3)).
//
//   node scripts/accounts/rights.mjs status
//   node scripts/accounts/rights.mjs erase 207119551 [--apply]
//   node scripts/accounts/rights.mjs export 207119551 [--apply]
//   node scripts/accounts/rights.mjs fetch <request id> [--out file.json] [--apply]
//   node scripts/accounts/rights.mjs close <request id> [--apply]
//
// The customer id is the number at the end of the Shopify admin customer
// URL (admin/customers/<id>), or its gid://shopify/Customer/<id> form.
//
// erase/export add a row to the D1 `rights_requests` queue; the production
// Worker works it within 5 minutes (app/lib/accounts/compliance.ts
// runRightsQueue), so this laptop needs neither the pairwise salt nor the
// ChatFPV key. `status` shows the queue. `fetch` writes a ready export to a
// file (mode 600) and, with --apply, clears the stored copy and marks the
// request done. `close` marks a request done after a manual resolution.
// Without --apply every write is a dry run that prints the SQL.
//
// Options:
//   --staging   use wrangler.toml (preview D1) instead of wrangler.production.toml
//   --out FILE  export file for fetch, default rights-export-<id>.json
//
// Uses `npx wrangler d1 execute SUPPORT_DB --remote` with the logged-in
// Wrangler account. Nothing secret is printed.

import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REQUEST_ID = /^(?:wh|rr|cli)_[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Pure parts (unit tested in app/lib/accounts/rights-cli.test.ts)
// ---------------------------------------------------------------------------

/** gid://shopify/Customer/<id> from a bare numeric id or a GID, else null. */
export function customerGid(raw) {
  const text = String(raw ?? '').trim();
  const m = /^(?:gid:\/\/shopify\/Customer\/)?([1-9][0-9]{0,19})$/.exec(text);
  return m ? `gid://shopify/Customer/${m[1]}` : null;
}

export function parseArgs(argv) {
  const opts = {command: null, target: null, apply: false, staging: false, out: null};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--staging') opts.staging = true;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  [opts.command, opts.target] = rest;
  if (!['status', 'erase', 'export', 'fetch', 'close'].includes(opts.command ?? '')) throw new Error('command: status | erase | export | fetch | close');
  if (opts.command === 'erase' || opts.command === 'export') {
    opts.target = customerGid(opts.target);
    if (!opts.target) throw new Error('give the Shopify customer id (number or gid://shopify/Customer/<id>)');
  }
  if ((opts.command === 'fetch' || opts.command === 'close') && !REQUEST_ID.test(opts.target ?? '')) {
    throw new Error('give the request id shown by status');
  }
  return opts;
}

/** The SQL for one command. Values are validated above, so inlining them is safe. */
export function sqlFor(opts, now = Date.now(), id = `cli_${crypto.randomBytes(9).toString('base64url')}`) {
  switch (opts.command) {
    case 'status':
      return "SELECT id, kind, source, shopify_gid, status, received_at, attempts, last_attempt_at, completed_at FROM rights_requests WHERE status != 'done' OR completed_at > " +
        (now - 30 * 24 * 60 * 60 * 1000) +
        ' ORDER BY received_at';
    case 'erase':
    case 'export':
      return `INSERT INTO rights_requests (id, kind, source, shopify_gid, status, received_at, attempts) VALUES ('${id}', '${opts.command}', 'founder', '${opts.target}', 'pending', ${now}, 0)`;
    case 'fetch':
      return `SELECT id, status, export_json FROM rights_requests WHERE id = '${opts.target}'`;
    case 'close':
      return `UPDATE rights_requests SET status = 'done', completed_at = ${now}, export_json = NULL WHERE id = '${opts.target}'`;
    default:
      throw new Error('unknown command');
  }
}

// ---------------------------------------------------------------------------
// Wrangler
// ---------------------------------------------------------------------------

function d1(opts, sql) {
  const config = opts.staging ? 'wrangler.toml' : 'wrangler.production.toml';
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'SUPPORT_DB', '--remote', '--config', config, '--json', '--command', sql], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out);
  return (Array.isArray(parsed) ? parsed[0]?.results : parsed?.results) ?? [];
}

const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '-');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = Date.now();
  if (opts.command === 'status') {
    const rows = d1(opts, sqlFor(opts, now));
    if (!rows.length) return console.log('No open requests, none closed in the last 30 days.');
    console.log('id | kind | source | customer | status | received | attempts | completed');
    for (const r of rows) {
      console.log([r.id, r.kind, r.source, r.shopify_gid ?? '-', r.status, day(r.received_at), r.attempts, day(r.completed_at)].join(' | '));
    }
    return;
  }
  if (opts.command === 'fetch') {
    const [row] = d1(opts, sqlFor(opts, now));
    if (!row) throw new Error('no such request');
    if (row.status !== 'ready' || !row.export_json) throw new Error(`request is ${row.status}, no export stored`);
    const file = path.resolve(opts.out ?? `rights-export-${row.id}.json`);
    fs.writeFileSync(file, JSON.stringify(JSON.parse(row.export_json), null, 2) + '\n', {mode: 0o600});
    console.log(`Wrote ${file}. Send it to the customer from privacy@opendrone.be.`);
    const close = sqlFor({...opts, command: 'close'}, now);
    if (!opts.apply) return console.log(`Dry run: with --apply this also runs\n  ${close}`);
    d1(opts, close);
    return console.log('Stored copy cleared; request marked done.');
  }
  const sql = sqlFor(opts, now);
  if (!opts.apply) return console.log(`Dry run (${opts.staging ? 'staging' : 'production'}). With --apply this runs:\n  ${sql}`);
  d1(opts, sql);
  if (opts.command === 'close') return console.log(`Request ${opts.target} marked done.`);
  console.log(`Queued. The Worker works it within 5 minutes; check with: node scripts/accounts/rights.mjs status`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
