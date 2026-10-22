/**
 * The editorial manifest of a build: every content item the site renders from this repository, with the hash of
 * its source. Generated at build time (vite.config.ts `editorialManifestPlugin`, virtual module
 * `virtual:editorial-manifest`), never at runtime, so the Worker needs no filesystem and no git. Node only.
 *
 * Read-only evidence for the company app's storefront console (capabilities `editorial.manifest` and
 * `publication.receipt`, incutec-app docs/storefront-chatfpv.md). Nothing here publishes anything.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

export const MANIFEST_SCHEMA = 1;

export type Classification = 'editable' | 'generated';

export type ManifestItem = {
  /** Repository path, forward slashes. The item's stable id. */
  path: string;
  /** legal | learn | copy | product | data */
  kind: string;
  locale: string | null;
  title: string;
  /** sha256 of the source bytes (hex). */
  sha256: string;
  /** Last commit that touched the file; null when the build had no full git history. */
  commit: string | null;
  committed_at: string | null;
  classification: Classification;
};

export type EditorialManifest = {
  schema: typeof MANIFEST_SCHEMA;
  renderer: {name: string; version: string};
  build: {commit: string | null; built_at: string};
  items: ManifestItem[];
  /** sha256 over the sorted (path, sha256) pairs: changes exactly when an allowlisted source changes. */
  manifest_hash: string;
  completeness: 'complete';
  /** What this manifest does not cover, so a reader never assumes more than it says. */
  gaps: string[];
};

/** Allowlist: only these roots, only these extensions. */
export const ROOTS: Array<{dir: string; ext: string}> = [
  {dir: 'content', ext: '.json'},
  {dir: 'app/content', ext: '.md'},
];

/** Files written by sync scripts or the campaign, not by an editor. */
const GENERATED = new Set([
  'content/contributors.json',
  'content/votes.json',
  'content/registrations.json',
  'content/preorders.json',
  'content/goals.json',
]);

export const DECLARED_GAPS = [
  'Blog posts, product catalog and prices are not repo-backed and are not listed.',
  'Images, fonts and other binary assets are not listed.',
  'Route components under app/routes and inline strings in code are not editorial content and are not listed.',
];

export const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

function walk(root: string, rel: string, ext: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(path.join(root, rel), {withFileTypes: true});
  } catch {
    return;
  }
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, child, ext, out);
    else if (e.isFile() && e.name.endsWith(ext)) out.push(child);
  }
}

export function kindOf(p: string): string {
  if (p.startsWith('app/content/legal/')) return 'legal';
  if (p.startsWith('app/content/learn/')) return 'learn';
  if (p.startsWith('content/copy/')) return 'copy';
  if (p.startsWith('content/products/')) return 'product';
  return 'data';
}

export function localeOf(p: string): string | null {
  return /^app\/content\/legal\/(en|nl|fr)\//.exec(p)?.[1] ?? null;
}

export function titleOf(p: string, text: string): string {
  try {
    if (p.endsWith('.json')) {
      const j = JSON.parse(text) as Record<string, unknown>;
      for (const k of ['$title', 'title', 'name']) if (typeof j[k] === 'string' && j[k]) return j[k] as string;
    } else {
      const m = /^\s*#{1,6}\s+(.+?)\s*$/m.exec(text.replace(/^---\n[\s\S]*?\n---\n/, ''));
      if (m) return m[1]!;
    }
  } catch {
    /* an unparsable file still gets a title from its name */
  }
  return path.basename(p).replace(/\.[^.]+$/, '');
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim() || null;
  } catch {
    return null;
  }
}

export type BuildOptions = {
  root: string;
  builtAt?: string;
  /** Tests: bypass git. */
  commit?: string | null;
  history?: (p: string) => {commit: string; at: string} | null;
};

export function buildManifest(opts: BuildOptions): EditorialManifest {
  const {root} = opts;
  const commit = opts.commit !== undefined ? opts.commit : git(root, ['rev-parse', 'HEAD']) ?? process.env.GITHUB_SHA ?? null;
  // A shallow checkout reports its one commit for every file: say "unknown" instead.
  const shallow = git(root, ['rev-parse', '--is-shallow-repository']) !== 'false';
  const history =
    opts.history ??
    ((p: string) => {
      if (shallow) return null;
      const line = git(root, ['log', '-1', '--format=%H %cI', '--', p]);
      const [c, at] = line?.split(' ') ?? [];
      return c && at ? {commit: c, at} : null;
    });
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {name: string; version: string};

  const paths: string[] = [];
  for (const r of ROOTS) walk(root, r.dir, r.ext, paths);
  paths.sort();

  const items: ManifestItem[] = paths.map((p) => {
    const bytes = readFileSync(path.join(root, p));
    const h = history(p);
    return {
      path: p,
      kind: kindOf(p),
      locale: localeOf(p),
      title: titleOf(p, bytes.toString('utf8')),
      sha256: sha256(bytes),
      commit: h?.commit ?? null,
      committed_at: h?.at ?? null,
      classification: GENERATED.has(p) ? 'generated' : 'editable',
    };
  });

  const gaps = [...DECLARED_GAPS];
  if (items.some((i) => i.commit === null)) gaps.push('Last commit per file is unknown when the build had no full git history.');
  return {
    schema: MANIFEST_SCHEMA,
    renderer: {name: pkg.name, version: pkg.version},
    build: {commit, built_at: opts.builtAt ?? new Date().toISOString()},
    items,
    manifest_hash: sha256(items.map((i) => `${i.path}\t${i.sha256}`).join('\n')),
    completeness: 'complete',
    gaps,
  };
}

/** The repository paths the manifest must cover (tests compare against it). */
export function allowlistedPaths(root: string): string[] {
  const out: string[] = [];
  for (const r of ROOTS) walk(root, r.dir, r.ext, out);
  return out.sort();
}
