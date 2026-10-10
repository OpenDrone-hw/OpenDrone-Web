#!/usr/bin/env node
/**
 * Export the published bench figures for the /testing workspace.
 *
 * A figure is a saved view in the testing repository (Graphs/views/<id>.json)
 * with a `publish` block. This script reads those views, asks the bench app
 * to compute each one, applies the honesty gate and writes
 *
 *   public/testing/index.json     products, runs, log, one summary per figure
 *   public/testing/fig/<id>.json  one figure: series, axes, caveats, citation
 *
 * A new published view appears on the page with no code or config edit, and
 * removing its publish block removes it on the next run. Views whose status
 * is needs-review, and views that fail the gate, go to the git-ignored
 * .testing-held/held.json and never to public/testing.
 *
 *   node scripts/sync-testing.mjs --write   regenerate public/testing
 *   node scripts/sync-testing.mjs --check   exit 1 on drift or a gate failure
 *
 * Inputs
 *   - The bench app, read only. TESTING_API (default http://127.0.0.1:8787).
 *     Exactly two calls exist: POST /api/numbers/figure (pure computation)
 *     and GET /api/fields. Any other path throws before a request is made.
 *     The app may be driving a real rig; nothing here arms, runs or saves.
 *   - The testing repository, for the views and the revision. TESTING_REPO
 *     (default /Users/stan/Incutec/testing).
 *   - The capture files, for the thrust stand holds only (the app's own hold
 *     reduction needs a current clamp, which that stand does not have).
 *     TESTING_DATA (default TESTING_REPO).
 *   - scripts/testing-export.config.json: the product map, the point cap and
 *     size budget, the banned strings and the thrust stand field rules.
 *   - scripts/testing-log.json: the hand-written engineering log.
 *
 * Honesty gate, per view, in this order
 *   status; thrust stand fields (no current, power or g per W, in the data or
 *   in the words); a simulated answer; banned strings over every word that is
 *   published; the finding's numbers against the view's checks; by and at to
 *   publish; no source under the private tree; no OpenFC-Core. A view that
 *   fails is held and the run exits 1.
 *
 * Shapes, written for the page:
 *   index.json  {products:[{handle,name,figures:[id]}], runs:{<run>:{date,
 *               setup[],chip}}, figures:{<id>:{title,finding,product,tier,
 *               featured,order,domain,runId,chip,caveats,flagged}}, log:[...],
 *               built}
 *   fig/<id>.json  {id,title,finding,product,tier,runId,domain,chip,
 *               caveats:[{text,flag?}],reduction,cite,axes:{x,y,y2?:{label,
 *               unit,min?,max?}},series:[{id,label,quantity,pack?,kind:
 *               "trace"|"frames"|"hold",axis?:"y2",x[],y[],lo?[],hi?[]}],
 *               holds:[{run,throttle,t0,t1,n}]}
 *   A gap is null in y, lo or hi and is never interpolated. A hold series is
 *   markers with a band, never a line. A caveat that starts with "!" in the
 *   view is flagged and opens the page's disclosure.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildFigure, buildIndex, compileConfig, loadBench, pretty, runOfRef, scan, validateLog} from './testing-export-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const OUT_DIR = process.env.TESTING_OUT || path.join(WEB_ROOT, 'public', 'testing');
const HELD_FILE = process.env.TESTING_HELD || path.join(WEB_ROOT, '.testing-held', 'held.json');
const LOG_FILE = process.env.TESTING_LOG || path.join(HERE, 'testing-log.json');
const API = (process.env.TESTING_API || 'http://127.0.0.1:8787').replace(/\/$/, '');
const REPO = process.env.TESTING_REPO || '/Users/stan/Incutec/testing';
const DATA = process.env.TESTING_DATA || REPO;

const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : null;
if (!mode) {
  console.error('usage: sync-testing.mjs --write | --check');
  process.exit(2);
}

const cfg = compileConfig(JSON.parse(fs.readFileSync(path.join(HERE, 'testing-export.config.json'), 'utf8')));

// ------------------------------------------------------------------ app API

/** The only two calls this script can make. */
const ALLOWED = new Set(['POST /api/numbers/figure', 'GET /api/fields']);

async function api(method, route, body) {
  if (!ALLOWED.has(`${method} ${route}`)) {
    throw new Error(`refused: ${method} ${route} is not on the read-only allow-list`);
  }
  const res = await fetch(API + route, {
    method,
    headers: body ? {'content-type': 'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function probeApp() {
  try {
    await api('GET', '/api/fields');
    return true;
  } catch {
    return false;
  }
}

/** The request body for a view: what the editor would send for it. */
function specOf(view) {
  const share = view.publish?.display?.share;
  const sources = (view.sources || []).filter((s) => s.enabled !== false).map((s) => ({id: s.id, ref: s.ref, label: s.label || s.id, enabled: true}));
  const ids = new Set(sources.map((s) => s.id));
  return {
    sources,
    x: {field: view.x?.field || 't', scale: view.x?.scale || 'linear', min: null, max: null},
    series: (view.series || [])
      .filter((s) => s.visible !== false && ids.has(s.source))
      .map((s) => ({
        id: s.id,
        source: s.source,
        field: s.field,
        axis: s.axis || 'left',
        style: share ? 'scatter' : s.style || 'line',
        visible: true,
        ...(s.band && s.band !== 'none' ? {band: s.band} : {}),
        ...(s.transform ? {transform: s.transform} : {}),
      })),
    reduce: view.reduce || 'hold',
    overlay: 'none',
    filters: view.filters || {},
  };
}

// ------------------------------------------------------------------ main

function readViews() {
  const dir = path.join(REPO, 'Graphs', 'views');
  if (!fs.existsSync(dir)) throw new Error(`no Graphs/views under ${REPO}`);
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch (e) {
      console.error(`unreadable view ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  return out;
}

const kb = (n) => (n / 1024).toFixed(1);

async function build() {
  const views = readViews();
  const benches = new Map();
  const published = [];
  const held = {needsReview: [], failed: []};
  let drafts = 0;
  let unmarked = 0;

  for (const view of views) {
    const status = view.publish?.status;
    if (!view.publish) {
      unmarked++;
      continue;
    }
    if (status === 'draft') {
      drafts++;
      continue;
    }
    const where = (view.id || '?') + ` (${status})`;
    try {
      for (const s of view.sources || []) {
        const run = runOfRef(s.ref);
        if (run && view.publish.holds && !benches.has(run)) benches.set(run, loadBench(DATA, run));
      }
      const resp = await api('POST', '/api/numbers/figure', specOf(view));
      const r = buildFigure(view, resp, benches, cfg);
      if (status === 'publish') {
        if (r.errors.length) held.failed.push({id: view.id, errors: r.errors});
        else published.push(r);
        console.log(`figure ${where}: ${r.errors.length ? 'FAILED' : r.fig.series.map((s) => `${s.kind}:${s.x.length}`).join(' ')}`);
      } else {
        held.needsReview.push({id: view.id, title: view.publish.title, errors: r.errors, figure: r.fullFig ?? null});
        console.log(`figure ${where}: held`);
      }
    } catch (e) {
      const entry = {id: view.id, errors: [`${view.id}: ${e.message}`]};
      if (status === 'publish') held.failed.push(entry);
      else held.needsReview.push({...entry, title: view.publish.title, figure: null});
      console.log(`figure ${where}: ${status === 'publish' ? 'FAILED' : 'held'}`);
    }
  }
  console.log(`views: ${views.length}; published ${published.length}; held ${held.needsReview.length}; failed ${held.failed.length}; draft ${drafts}; without a publish block ${unmarked}`);
  return {published, held};
}

function sourceRevision() {
  try {
    return execFileSync('git', ['-C', REPO, 'rev-parse', '--short=7', 'HEAD'], {encoding: 'utf8'}).trim();
  } catch {
    return 'unknown';
  }
}

/** Files under OUT_DIR by relative path, for the stale and drift checks. */
function filesOnDisk() {
  const out = new Map();
  const walk = (dir, rel) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, rel + name + '/');
      else out.set(rel + name, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(OUT_DIR, '');
  return out;
}

const withoutBuilt = (text) => {
  const j = JSON.parse(text);
  delete j.built;
  return JSON.stringify(j);
};

async function main() {
  const appUp = await probeApp();
  console.log(`bench app: ${appUp ? API : 'not reachable'}; views: ${REPO}; captures: ${DATA}`);
  if (!appUp) {
    if (mode === 'write') throw new Error('the bench app is not reachable: nothing to write');
    console.warn('no bench app: scanning the files on disk only');
    return scanDisk();
  }

  const {published, held} = await build();
  const errors = held.failed.flatMap((f) => f.errors);

  const logFile = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  const ids = new Set(published.map((p) => p.fig.id));
  errors.push(...validateLog(logFile.items, ids, cfg));
  const {index, errors: indexErrors} = buildIndex(published, logFile.items.filter((t) => t.status === 'publish'), cfg, new Date().toISOString().slice(0, 10));
  errors.push(...indexErrors);

  const next = new Map();
  next.set('index.json', pretty(index));
  for (const p of published) next.set(`fig/${p.fig.id}.json`, pretty(p.fig));

  const hits = [];
  scan(index, 'index', hits, cfg);
  for (const h of hits) errors.push(`banned: ${h}`);

  const budget = cfg.figureBudgetKb * 1024;
  for (const [name, text] of next) {
    const raw = Buffer.byteLength(text);
    const gz = zlib.gzipSync(text).length;
    console.log(`  ${name}: ${kb(raw)} KB (gzip ${kb(gz)} KB)`);
    if (name.startsWith('fig/') && raw > budget) errors.push(`${name}: ${kb(raw)} KB is over the ${cfg.figureBudgetKb} KB budget`);
  }

  if (mode === 'write') {
    fs.mkdirSync(path.dirname(HELD_FILE), {recursive: true});
    fs.writeFileSync(HELD_FILE, pretty({schema: 2, built: index.built, ...held}));
  }
  if (errors.length) {
    for (const e of errors) console.error(`invalid: ${e}`);
    process.exit(1);
  }

  const disk = filesOnDisk();
  if (mode === 'write') {
    fs.mkdirSync(path.join(OUT_DIR, 'fig'), {recursive: true});
    for (const [name, text] of next) fs.writeFileSync(path.join(OUT_DIR, name), text);
    for (const name of disk.keys()) {
      if (!next.has(name)) {
        fs.rmSync(path.join(OUT_DIR, name));
        console.log(`  removed ${name}: no longer published`);
      }
    }
    console.log(`wrote ${next.size} files to ${path.relative(WEB_ROOT, OUT_DIR) || OUT_DIR} (testing revision ${sourceRevision()})`);
    return;
  }
  let drift = false;
  for (const [name, text] of next) {
    const have = disk.get(name);
    const same = have !== undefined && (name === 'index.json' ? withoutBuilt(have) === withoutBuilt(text) : have === text);
    if (!same) {
      drift = true;
      console.error(`DRIFT: ${name} differs from the export`);
    }
  }
  for (const name of disk.keys()) {
    if (!next.has(name)) {
      drift = true;
      console.error(`DRIFT: ${name} is on disk and no view publishes it`);
    }
  }
  if (drift) process.exit(1);
  console.log('public/testing is in sync');
}

/** --check without the app: the banned-string scan and the budget on what is on disk. */
function scanDisk() {
  const hits = [];
  for (const [name, text] of filesOnDisk()) {
    scan(JSON.parse(text), name, hits, cfg);
    if (Buffer.byteLength(text) > cfg.figureBudgetKb * 1024) hits.push(`${name}: over ${cfg.figureBudgetKb} KB`);
  }
  if (hits.length) {
    for (const h of hits) console.error(`banned: ${h}`);
    process.exit(1);
  }
  console.log('public/testing: no banned strings');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
