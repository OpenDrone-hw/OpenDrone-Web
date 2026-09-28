#!/usr/bin/env node
/**
 * Import product specs from the board repo READMEs.
 *
 * The board repos are the source of truth for specs; the website is a
 * maintained mirror (drafts/repo-sync-plan.md). This is the whole pipeline:
 * read the LOCAL checkouts named in scripts/repo-sync.config.json, parse the
 * first `| key | value |` table under `## Specifications` in each mapped
 * README, and rewrite ONLY the spec arrays in content/products/<handle>.json.
 * No network, no schedule: whoever edits a README runs this, the same way a
 * board change and gen:board-art are one act.
 *
 *   node scripts/import-specs.mjs --check   diff, exit 1 on drift
 *   node scripts/import-specs.mjs --write   apply (refuses dirty checkouts)
 *
 * Shape produced. The first variant listed in the config is the base: its
 * table becomes the product's shared `specs`. Every other variant becomes a
 * per-tier override list against that base, in mergeSpecs' vocabulary
 * (products.$handle.tsx): same key = replace, `[key, null]` = hide a base
 * row the variant's README does not carry, unknown key = append. A tier
 * whose README matches the base exactly gets NO override list.
 *
 * Typography. Repo tables stay plain ASCII; the site keeps its marks. The
 * importer applies exactly three rewrites to values (documented here, nowhere
 * else): a hyphen BETWEEN DIGITS becomes an en dash (2-6S -> 2–6S; 6-layer
 * and JST-SH are untouched), ` x ` between digits becomes ` × ` (20 x 20 mm),
 * and a count multiplier `<digits>x ` becomes `<digits>× ` (4x DShot). Nothing
 * else is rewritten; if the site should show a mark, put the plain-ASCII form
 * of the fact in the README and extend these rules deliberately.
 *
 * Site overrides. `siteOverrides` in the config replaces one README value
 * (`from`, after the typography rules) with `value` in every variant that
 * carries it, for a hardware figure the storefront must not publish (a
 * transmit maximum above the EU firmware cap). Each entry names its reason;
 * an override that matches no row is an error, so a README change surfaces.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const CONFIG = path.join(HERE, 'repo-sync.config.json');

const mode = process.argv.includes('--write')
  ? 'write'
  : process.argv.includes('--check')
    ? 'check'
    : null;
if (!mode) {
  console.error('usage: import-specs.mjs --check | --write');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
// The board checkouts: OPENDRONE_HARDWARE when set, else the config's root.
const root = (process.env.OPENDRONE_HARDWARE || cfg.root).replace(
  /^~(?=\/)/,
  os.homedir(),
);

/** The three typography rules. Keep this the only place they exist. */
function normalize(value) {
  return value
    .replace(/(?<=\d) ?x ?(?=\d)/g, ' × ')
    .replace(/(?<=\d)x(?= )/g, '×')
    .replace(/(?<=\d)-(?=\d)/g, '–');
}

/** Parse the first `| key | value |` table under `## Specifications`. */
function parseSpecTable(readmePath) {
  const text = fs.readFileSync(readmePath, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Specifications\b/.test(l));
  if (start < 0) throw new Error(`${readmePath}: no "## Specifications" heading`);
  const rows = [];
  let inTable = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^##\s/.test(line)) break; // next section
    const isRow = /^\|.*\|$/.test(line);
    if (!isRow) {
      if (inTable) break; // table ended
      continue;
    }
    inTable = true;
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length !== 2) continue; // header `| | |` or separator
    if (/^[-: ]+$/.test(cells[0]) && /^[-: ]+$/.test(cells[1])) continue;
    if (cells[0] === '' && cells[1] === '') continue;
    if (cells[0] === '') throw new Error(`${readmePath}: spec row with empty key`);
    rows.push([cells[0], normalize(cells[1])]);
  }
  if (!rows.length) throw new Error(`${readmePath}: Specifications table is empty`);
  return rows;
}

/** Refuse to mirror a half-edited or stale checkout. */
function checkoutTrouble(repoDir) {
  const git = (...args) =>
    execFileSync('git', ['-C', repoDir, ...args], {encoding: 'utf8'}).trim();
  try {
    if (git('status', '--porcelain') !== '') return 'has uncommitted changes';
  } catch {
    return 'is not a git checkout';
  }
  try {
    // Local refs only, deliberately: this pipeline never touches the network.
    const behind = git('rev-list', '--count', 'HEAD..@{u}');
    if (behind !== '0') return `is behind its (locally known) upstream by ${behind}`;
  } catch {
    // No upstream configured: nothing to compare against.
  }
  return null;
}

/** Overrides for one variant against the base rows, in mergeSpecs terms. */
function overridesAgainst(base, rows) {
  const map = new Map(rows);
  const out = [];
  for (const [k, v] of base) {
    if (!map.has(k)) out.push([k, null]);
    else if (map.get(k) !== v) out.push([k, map.get(k)]);
  }
  const baseKeys = new Set(base.map(([k]) => k));
  for (const [k, v] of rows) if (!baseKeys.has(k)) out.push([k, v]);
  return out;
}

let drift = false;

// Guard pass first, over every mapped checkout, so --write is all-or-nothing:
// a trouble found on the last repo must not leave the first one half-written.
const problems = [];
for (const product of cfg.products) {
  for (const v of product.variants) {
    const trouble = checkoutTrouble(path.join(root, v.repo));
    if (trouble) problems.push(`${v.repo} ${trouble}`);
  }
}
if (problems.length && mode === 'write') {
  for (const p of problems) console.error(`refusing --write: ${p}`);
  process.exit(1);
}
for (const p of problems) console.warn(`warning: ${p}`);

for (const product of cfg.products) {
  const jsonPath = path.join(WEB_ROOT, 'content', 'products', `${product.handle}.json`);
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  const tables = [];
  for (const v of product.variants) {
    const repoDir = path.join(root, v.repo);
    if (!(v.tier in (data.variants ?? {}))) {
      throw new Error(`${product.handle}: variant "${v.tier}" not in ${jsonPath}`);
    }
    tables.push({tier: v.tier, rows: parseSpecTable(path.join(repoDir, 'README.md'))});
  }

  // Site overrides: a README value the storefront must not publish is
  // replaced in every variant that carries it (config `siteOverrides`).
  for (const o of cfg.siteOverrides ?? []) {
    if (o.handle !== product.handle) continue;
    let hit = false;
    for (const t of tables) {
      for (const row of t.rows) {
        if (row[0] === o.key && row[1] === o.from) {
          row[1] = o.value;
          hit = true;
        }
      }
    }
    if (!hit) {
      throw new Error(
        `${product.handle}: site override "${o.key}: ${o.from}" matches no README row`,
      );
    }
  }

  const base = tables[0].rows;
  const next = structuredClone(data);
  next.specs = base;
  for (const t of tables) {
    const over = t.tier === tables[0].tier ? [] : overridesAgainst(base, t.rows);
    if (over.length) next.variants[t.tier].specs = over;
    else delete next.variants[t.tier].specs;
  }

  const before = JSON.stringify({s: data.specs, v: Object.fromEntries(Object.entries(data.variants).map(([k, x]) => [k, x.specs ?? null]))});
  const after = JSON.stringify({s: next.specs, v: Object.fromEntries(Object.entries(next.variants).map(([k, x]) => [k, x.specs ?? null]))});
  if (before === after) {
    console.log(`${product.handle}: in sync`);
    continue;
  }
  drift = true;
  console.log(`${product.handle}: DRIFT`);
  console.log('  now :', before);
  console.log('  repo:', after);
  if (mode === 'write') {
    fs.writeFileSync(jsonPath, JSON.stringify(next, null, 2) + '\n');
    console.log(`  wrote ${path.relative(WEB_ROOT, jsonPath)}`);
  }
}

if (mode === 'check' && drift) process.exit(1);
