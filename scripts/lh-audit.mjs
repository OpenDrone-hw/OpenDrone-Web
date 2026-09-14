#!/usr/bin/env node
/**
 * Lighthouse lab audit of the storefront, mobile or desktop preset, one row per
 * route. Second opinion next to scripts/perf-audit.mjs (which measures
 * interaction, frames and long tasks): this one gives the page-load vitals
 * the field data is scored on (FCP, LCP, CLS, TBT, Speed Index, bytes).
 *
 * Usage:
 *   node scripts/lh-audit.mjs [--url https://opendrone.be] [--form mobile|desktop]
 *     [--routes /,/products/openesc,...] [--out .lh]
 *
 * mobile = Lighthouse's Moto G Power class (4x CPU slowdown, slow 4G, 412 px);
 * desktop = its desktop preset (no CPU slowdown, 10 Mbps, 1350 px). Runs
 * `npx lighthouse` (no repo dependency; npx fetches it once) and writes one
 * JSON per route into --out (default .lh/, gitignored) so runs can be diffed.
 * Numbers are simulated throttling: compare runs against each other, not
 * against a phone in your hand. For that, plug the phone in (chrome://inspect).
 */
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const BASE = argVal('url', 'https://opendrone.be').replace(/\/$/, '');
const FORM = argVal('form', 'mobile');
const OUT = argVal('out', '.lh');
const ROUTES = argVal('routes', '/,/products/openesc,/products/openrx,/products,/roadmap')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

mkdirSync(OUT, {recursive: true});
const rows = [];
for (const route of ROUTES) {
  const slug = route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-');
  const file = join(OUT, `${FORM}-${slug}.json`);
  const flags = [
    'lighthouse',
    BASE + route,
    '--only-categories=performance',
    '--output=json',
    `--output-path=${file}`,
    '--quiet',
    '--chrome-flags=--headless=new',
  ];
  if (FORM === 'desktop') flags.push('--preset=desktop');
  else flags.push('--form-factor=mobile', '--screenEmulation.mobile');
  execFileSync('npx', ['--yes', ...flags], {stdio: 'inherit'});
  const a = JSON.parse(readFileSync(file, 'utf8'));
  const au = a.audits;
  const ms = (k) => Math.round(au[k]?.numericValue ?? 0);
  const items = au['network-requests']?.details?.items ?? [];
  const kb = (t) =>
    Math.round(items.filter((i) => !t || i.resourceType === t).reduce((s, i) => s + (i.transferSize || 0), 0) / 1024);
  rows.push({
    route,
    score: Math.round((a.categories.performance.score ?? 0) * 100),
    fcp: ms('first-contentful-paint'),
    lcp: ms('largest-contentful-paint'),
    cls: +(au['cumulative-layout-shift']?.numericValue ?? 0).toFixed(3),
    tbt: ms('total-blocking-time'),
    si: ms('speed-index'),
    kb: kb(),
    fontKb: kb('Font'),
    imgKb: kb('Image'),
    jsKb: kb('Script'),
  });
}
const pad = (v, n) => String(v).padStart(n);
console.error(`\n${FORM} @ ${BASE}`);
console.error(
  ['route'.padEnd(22), pad('score', 5), pad('FCP', 6), pad('LCP', 6), pad('CLS', 6), pad('TBT', 5), pad('SI', 6), pad('KB', 6), pad('font', 5), pad('img', 5), pad('js', 5)].join(' '),
);
for (const r of rows) {
  console.error(
    [r.route.padEnd(22), pad(r.score, 5), pad(r.fcp, 6), pad(r.lcp, 6), pad(r.cls, 6), pad(r.tbt, 5), pad(r.si, 6), pad(r.kb, 6), pad(r.fontKb, 5), pad(r.imgKb, 5), pad(r.jsKb, 5)].join(' '),
  );
}
console.log(JSON.stringify(rows, null, 2));
