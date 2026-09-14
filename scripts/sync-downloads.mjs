#!/usr/bin/env node
/**
 * Mirror the latest GitHub release assets of each board repo into the
 * `downloads` array of its product JSON.
 *
 * Same principle as import-specs.mjs: the repos are the source, the site is a
 * maintained mirror, one repeatable command run at release step 9, landing as
 * a normal PR. The one difference is that release assets live on GitHub, not
 * in the checkout, so this asks `gh release view` for the latest release of
 * every repo in scripts/repo-sync.config.json.
 *
 *   node scripts/sync-downloads.mjs --check   print what would be written, exit 1 on drift
 *   node scripts/sync-downloads.mjs --write   apply
 *
 * PREPARED, NOT SWITCHED ON (maintainer, 2026-08-15): the downloads chapter stays
 * empty on every product for now, so nobody runs --write yet. The mapping and
 * the naming convention below are the contract to release against in the
 * meantime; the day the chapter is wanted, run --write and open the PR.
 *
 * Asset kinds are read off the file name, and only these shapes are known:
 *
 *   *schematic*.pdf   -> schematic
 *   *.step / *.stp    -> step
 *   *bom*.csv         -> bom
 *   *manual*.pdf      -> manual
 *   *.zip             -> gerber   (the JLCPCB fab set: gerbers, BOM, CPL)
 *
 * Anything else is skipped and reported, never guessed. Release step 8 in
 * The OpenDrone release profile names the assets so they match:
 * <Repo>-<rev>-fab.zip, <Repo>-<rev>.step, <Repo>-<rev>-schematic.pdf.
 *
 * Only entries this script wrote (marked `"synced": true`) are replaced; a
 * hand-written download entry survives every run.
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const CONFIG = path.join(HERE, 'repo-sync.config.json');
const ORG = 'OpenDrone-hw';

const mode = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--check')
    ? 'check'
    : null;
if (!mode) {
  console.error('usage: sync-downloads.mjs --check | --write');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

function kindOf(name) {
  const n = name.toLowerCase();
  if (/schematic.*\.pdf$/.test(n)) return 'schematic';
  if (/\.(step|stp)$/.test(n)) return 'step';
  if (/bom.*\.csv$/.test(n)) return 'bom';
  if (/manual.*\.pdf$/.test(n)) return 'manual';
  if (/\.zip$/.test(n)) return 'gerber';
  return null;
}

const LABEL = {
  schematic: 'Schematic (PDF)',
  step: 'STEP model',
  bom: 'BOM (CSV)',
  manual: 'Manual (PDF)',
  gerber: 'JLCPCB fab set (gerbers, BOM, CPL)',
};

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function latestRelease(repo) {
  const out = execFileSync(
    'gh',
    ['release', 'view', '-R', `${ORG}/${repo}`, '--json', 'tagName,assets,url'],
    {encoding: 'utf8'},
  );
  return JSON.parse(out);
}

let drift = false;
for (const product of cfg.products) {
  const jsonPath = path.join(WEB_ROOT, 'content', 'products', `${product.handle}.json`);
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const generated = [];
  const skipped = [];
  for (const v of product.variants) {
    let rel;
    try {
      rel = latestRelease(v.repo);
    } catch {
      console.warn(`${v.repo}: no release, skipped`);
      continue;
    }
    for (const a of rel.assets) {
      const kind = kindOf(a.name);
      if (!kind) {
        skipped.push(`${v.repo} ${rel.tagName}: ${a.name}`);
        continue;
      }
      generated.push({
        kind,
        label: `${LABEL[kind]} · ${v.tier}`,
        href: a.url,
        note: `${v.repo} ${rel.tagName}`,
        size: humanSize(a.size),
        synced: true,
      });
    }
  }
  const kept = (data.downloads ?? []).filter((d) => !d.synced);
  const next = [...kept, ...generated];
  const before = JSON.stringify(data.downloads ?? []);
  const after = JSON.stringify(next);
  for (const s of skipped) console.warn(`  unknown asset shape, not mirrored: ${s}`);
  if (before === after) {
    console.log(`${product.handle}: in sync`);
    continue;
  }
  drift = true;
  console.log(`${product.handle}: DRIFT (${generated.length} synced entries, ${kept.length} kept)`);
  for (const g of generated) console.log(`  + ${g.kind.padEnd(10)} ${g.note.padEnd(24)} ${g.href}`);
  if (mode === 'write') {
    data.downloads = next;
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
    console.log(`  wrote ${path.relative(WEB_ROOT, jsonPath)}`);
  }
}
if (mode === 'check' && drift) process.exit(1);
