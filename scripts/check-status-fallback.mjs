#!/usr/bin/env node
/**
 * Fallback discipline check for the product status system.
 *
 * The `status-*` topic on each board repo is the canonical status and gates
 * price and cart (docs/product-status.md). The static status in
 * app/lib/roadmap-data.ts is only the stand-in when the GitHub API is down,
 * and it must LAG the topic, never lead it: a static `beta` while the repo
 * says `alpha` would show a price exactly when nobody is looking. This
 * script fetches the live topic for every ROADMAP entry with a repo link and
 * exits 1 when a static value sits ahead of it. CI runs it on every PR
 * (`npm run check:status`); it also runs locally against the same API.
 *
 * Also fails when a linked repo is unreachable (404: private, renamed or
 * deleted) or carries no recognised status topic, since either leaves the
 * page pinned to the static value with nothing to lag behind.
 *
 * Auth: GITHUB_TOKEN or GITHUB_STATUS_TOKEN if set (5000/h). Unauthenticated
 * the fan-out is a dozen calls against a 60/h budget, fine for one run.
 */
import process from 'node:process';

const {ROADMAP, STATUS_ORDER} = await import('../app/lib/roadmap-data.ts');

const token = process.env.GITHUB_TOKEN || process.env.GITHUB_STATUS_TOKEN;
const headers = {
  'User-Agent': 'opendrone-web-status-check',
  Accept: 'application/vnd.github+json',
  ...(token ? {Authorization: `Bearer ${token}`} : {}),
};

// External entries (repos outside the org) carry a curated status and no topic.
const linked = ROADMAP.filter((r) => r.link);
const failures = [];
const rows = [];

await Promise.all(
  linked.map(async (r) => {
    const name = r.link.replace('https://github.com/', '');
    let live = null;
    let note = '';
    try {
      const res = await fetch(`https://api.github.com/repos/${name}/topics`, {
        headers,
        signal: AbortSignal.timeout(8000),
      });
      if (res.status === 403 || res.status === 429) {
        note = `rate limited (${res.status})`;
      } else if (!res.ok) {
        failures.push(`${r.id}: ${name} unreachable (HTTP ${res.status})`);
        note = `HTTP ${res.status}`;
      } else {
        const data = await res.json();
        live =
          (data.names ?? [])
            .find((t) => t.startsWith('status-'))
            ?.slice('status-'.length) ?? null;
        if (!r.external && (!live || !STATUS_ORDER.includes(live))) {
          failures.push(
            `${r.id}: ${name} carries no recognised status-* topic (${
              (data.names ?? []).join(', ') || 'none'
            })`,
          );
        }
      }
    } catch (err) {
      note = `fetch failed: ${err.message}`;
    }
    rows.push({id: r.id, repo: name, static: r.status, live, note});
    if (live && STATUS_ORDER.includes(live)) {
      // STATUS_ORDER runs launched -> planned, so a LOWER index is further
      // along. Static ahead of live = static index < live index.
      if (STATUS_ORDER.indexOf(r.status) < STATUS_ORDER.indexOf(live)) {
        failures.push(
          `${r.id}: static '${r.status}' is AHEAD of repo topic '${live}' on ${name}`,
        );
      }
    }
  }),
);

// Org drift: a public org repo that carries a status-* topic is a board and
// must appear on the roadmap. Family hubs (topic family-hub, e.g. OpenRX) are
// covered by their board repos. Archived repos must not be linked.
try {
  const res = await fetch(
    'https://api.github.com/orgs/OpenDrone-hw/repos?type=public&per_page=100',
    {headers, signal: AbortSignal.timeout(8000)},
  );
  if (res.ok) {
    const repos = await res.json();
    const linkedNames = new Set(linked.map((r) => r.link.split('/').pop()));
    for (const repo of repos) {
      const topics = repo.topics ?? [];
      const isBoard = topics.some((t) => t.startsWith('status-'));
      if (repo.archived && linkedNames.has(repo.name)) {
        failures.push(`${repo.name} is archived but linked from the roadmap`);
      }
      if (isBoard && !repo.archived && !topics.includes('family-hub') && !linkedNames.has(repo.name)) {
        failures.push(`${repo.name} has a status-* topic but is not on the roadmap`);
      }
    }
  } else {
    console.warn(`org listing skipped (HTTP ${res.status})`);
  }
} catch (err) {
  console.warn(`org listing skipped: ${err.message}`);
}

rows.sort((a, b) => a.id.localeCompare(b.id));
for (const row of rows) {
  const state =
    row.live == null
      ? row.note || 'no topic'
      : row.live === row.static
        ? 'in sync'
        : `static lags (${row.static} < ${row.live})`;
  console.log(
    `${row.id.padEnd(22)} ${row.repo.padEnd(34)} static=${row.static.padEnd(12)} live=${String(row.live).padEnd(12)} ${state}`,
  );
}

const rateLimited = rows.filter((r) => /rate limited/.test(r.note)).length;
if (rateLimited) {
  console.warn(
    `\n${rateLimited} repo(s) rate limited; set GITHUB_TOKEN for a full check.`,
  );
}

if (failures.length) {
  console.error('\nStatus fallback check FAILED:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nRule: flip the topic first, then lower or raise the static value in a follow-up. The static value must never lead the repo.',
  );
  process.exit(1);
}
console.log('\nStatus fallback OK: every static status lags or matches its repo topic.');
