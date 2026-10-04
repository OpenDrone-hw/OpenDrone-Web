#!/usr/bin/env node
// Copy the lab walkthrough's runtime files into public/lab-visit/.
//
//   node scripts/sync-lab-visit.mjs <game dir>
//   LAB_VISIT_DIR=<game dir> node scripts/sync-lab-visit.mjs
//   node scripts/sync-lab-visit.mjs --check <game dir>   # exit 1 when out of date
//
// The walkthrough is a static site (index.html plus the files it loads) whose
// source, tests and bake tools live outside this repository. Only the files a
// browser needs are copied; tests, tools, docs and the bundled index.sog are
// not. The scan is the unbundled form (scan/meta.json plus WebP files), so no
// file exceeds the Workers static asset limit of 25 MiB, which this checks.

import {createHash} from 'node:crypto';
import {cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';

const RUNTIME = ['index.html', 'config.json', 'css', 'data', 'i18n', 'js', 'vendor', 'scan'];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEST = resolve(import.meta.dirname, '..', 'public', 'lab-visit');

const args = process.argv.slice(2);
const check = args[0] === '--check';
if (check) args.shift();
if (args.some((a) => a.startsWith('-')) || args.length > 1) {
  console.error('usage: sync-lab-visit.mjs [--check] [game dir]');
  process.exit(2);
}
const src = resolve(args[0] ?? process.env.LAB_VISIT_DIR ?? '');
if (!args[0] && !process.env.LAB_VISIT_DIR) {
  console.error('Give the game directory as an argument or LAB_VISIT_DIR.');
  process.exit(2);
}

function files(dir) {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  return readdirSync(dir, {withFileTypes: true})
    .filter((e) => !e.name.startsWith('.') && e.name !== '__pycache__')
    .flatMap((e) => files(join(dir, e.name)));
}

function digest(root) {
  const out = new Map();
  for (const entry of RUNTIME) {
    for (const f of files(join(root, entry))) {
      out.set(relative(root, f), createHash('sha256').update(readFileSync(f)).digest('hex'));
    }
  }
  return out;
}

for (const entry of RUNTIME) {
  if (!existsSync(join(src, entry))) {
    console.error(`missing ${entry} in ${src}`);
    process.exit(1);
  }
}

const too = [...digest(src).keys()].filter((f) => statSync(join(src, f)).size > MAX_FILE_BYTES);
if (too.length) {
  console.error(`over 25 MiB, cannot be a static asset: ${too.join(', ')}`);
  process.exit(1);
}

if (check) {
  const a = digest(src);
  const b = digest(DEST);
  const diff = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
  if (diff.length) {
    console.error(`public/lab-visit is out of date (${diff.length} files), e.g. ${diff.slice(0, 5).join(', ')}`);
    process.exit(1);
  }
  process.stdout.write(`public/lab-visit matches ${src} (${a.size} files)\n`);
  process.exit(0);
}

// A dev setup may point public/lab-visit at the game folder with a symlink.
// Remove the link itself, never what it points to.
if (existsSync(DEST) && lstatSync(DEST).isSymbolicLink()) unlinkSync(DEST);
else rmSync(DEST, {recursive: true, force: true});
for (const entry of RUNTIME) {
  cpSync(join(src, entry), join(DEST, entry), {
    recursive: true,
    filter: (p) =>
      !relative(src, p)
        .split('/')
        .some((part) => part.startsWith('.') || part === '__pycache__'),
  });
}
const copied = digest(DEST);
const bytes = [...copied.keys()].reduce((n, f) => n + statSync(join(DEST, f)).size, 0);
process.stdout.write(`copied ${copied.size} files, ${(bytes / 1048576).toFixed(1)} MB, to public/lab-visit\n`);
