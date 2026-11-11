#!/usr/bin/env node
/**
 * Maintain the timeline ledger: the dated, receipted record of what GitHub
 * can prove about the project without anyone writing it down.
 *
 *   release  a release published on any public OpenDrone-hw repo
 *            (tag, name, published_at, html_url)
 *   repo     a public repo appearing (date = the repo's created_at)
 *   status   the status-* topic on a repo changing (date = the day the
 *            change was first observed; GitHub keeps no topic history, so
 *            the first run only records the baseline and emits nothing)
 *
 * A repo that stops being public is marked `gone` in `repos`; the site then
 * hides its events, whose links no longer resolve.
 *
 * The ledger is a JSON file on the unprotected `data` branch of this repo,
 * written by .github/workflows/timeline-ledger.yml once a day and read by
 * /timeline at request time (app/lib/timeline-ledger.ts). It never goes
 * through main, so no PR, no merge, no deploy: cut a tag on a board and it
 * is on the site the next day, dated and linked to the release.
 *
 * Run:  node scripts/sync-timeline.mjs --ledger ledger/timeline-ledger.json
 *       add --write to save; without it the script prints what would change.
 * Env:  GITHUB_TOKEN (the workflow's own token is enough: public read).
 *
 * Events are only ever appended (an id is stable: release:<repo>:<tag>,
 * repo:<repo>, status:<repo>:<status>:<date>), so a curated correction on
 * the site is a matter of dropping the id, not fighting the script.
 */
import fs from 'node:fs';
import path from 'node:path';

const ORG = 'OpenDrone-hw';
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const li = args.indexOf('--ledger');
const LEDGER = li >= 0 ? args[li + 1] : 'ledger/timeline-ledger.json';
const TOKEN = process.env.GITHUB_TOKEN;
const TODAY = new Date().toISOString().slice(0, 10);

async function gh(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'opendrone-timeline-ledger',
      ...(TOKEN ? {Authorization: `Bearer ${TOKEN}`} : {}),
    },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function listRepos() {
  const out = [];
  for (let page = 1; page < 10; page++) {
    const batch = await gh(
      `https://api.github.com/orgs/${ORG}/repos?type=public&per_page=100&page=${page}`,
    );
    out.push(...batch);
    if (batch.length < 100) break;
  }
  // Forks and dot-repos (.github, .github-private) are plumbing, not news.
  return out.filter((r) => !r.fork && !r.name.startsWith('.'));
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) {
    return {version: 1, updatedAt: null, repos: {}, events: []};
  }
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
}

const repos = await listRepos();
const ledger = loadLedger();
const known = new Set(ledger.events.map((e) => e.id));
const added = [];
const add = (e) => {
  if (known.has(e.id)) return;
  known.add(e.id);
  ledger.events.push({...e, observed: TODAY});
  added.push(e);
};

for (const r of repos) {
  const name = r.name;
  const status = (r.topics ?? []).find((t) => t.startsWith('status-'))?.slice(7) ?? null;
  const prev = ledger.repos[name];
  const created = (r.created_at ?? '').slice(0, 10);

  add({
    id: `repo:${name}`,
    kind: 'repo',
    repo: name,
    date: created,
    url: r.html_url,
    archived: Boolean(r.archived),
  });

  // Status flips: baseline silently on first sight, event on every change.
  if (prev && prev.status !== status && status) {
    add({
      id: `status:${name}:${status}:${TODAY}`,
      kind: 'status',
      repo: name,
      date: TODAY,
      status,
      from: prev.status ?? null,
      url: r.html_url,
    });
  }

  let releases = [];
  try {
    releases = await gh(
      `https://api.github.com/repos/${ORG}/${name}/releases?per_page=100`,
    );
  } catch (err) {
    console.warn(`[timeline] releases ${name}: ${err.message}`);
  }
  for (const rel of releases) {
    if (rel.draft || !rel.published_at) continue;
    add({
      id: `release:${name}:${rel.tag_name}`,
      kind: 'release',
      repo: name,
      date: rel.published_at.slice(0, 10),
      tag: rel.tag_name,
      name: rel.name && rel.name !== rel.tag_name ? rel.name : null,
      prerelease: Boolean(rel.prerelease),
      url: rel.html_url,
    });
  }

  ledger.repos[name] = {
    createdAt: created,
    status,
    statusSince: prev && prev.status === status ? prev.statusSince : TODAY,
    archived: Boolean(r.archived),
    releases: releases.filter((x) => !x.draft).length,
  };
}

// A repo that is no longer public (made private, renamed or deleted) keeps
// its events, which are history, but every link to it is dead: mark it
// `gone` so /timeline drops them (app/lib/timeline-live.ts). An empty list is
// an API hiccup, not an empty organisation: nothing is marked then.
const listed = new Set(repos.map((r) => r.name));
const gone = [];
if (repos.length) {
  for (const [name, entry] of Object.entries(ledger.repos)) {
    if (listed.has(name) || entry.gone) continue;
    entry.gone = TODAY;
    gone.push(name);
  }
}

ledger.events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
ledger.updatedAt = new Date().toISOString();

console.log(`${repos.length} repos, ${ledger.events.length} events, ${added.length} new`);
for (const name of gone) console.log(`  - ${name} is no longer public`);
for (const e of added) console.log(`  + ${e.date} ${e.kind} ${e.repo}${e.tag ? ' ' + e.tag : ''}${e.status ? ' -> ' + e.status : ''}`);

if (WRITE) {
  fs.mkdirSync(path.dirname(LEDGER), {recursive: true});
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
  console.log(`wrote ${LEDGER}`);
} else {
  console.log('(dry run: add --write to save)');
}
