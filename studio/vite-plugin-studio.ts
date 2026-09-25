/**
 * The studio's write path. Dev only, by construction rather than by promise.
 *
 * Three facts about this repo shape everything below.
 *
 * 1. In dev, `@cloudflare/vite-plugin` forwards requests into a workerd
 *    sandbox. Workerd has no filesystem and wrangler.toml sets no
 *    `nodejs_compat` flag, so a write handled anywhere downstream of that proxy
 *    cannot touch disk. This plugin therefore registers `order: 'pre'` and is
 *    listed BEFORE `cloudflare()` in vite.config.ts, and it never calls
 *    `next()` for a path it owns. It runs in
 *    the real Node process, which is the only place `node:fs` exists.
 *
 * 2. `apply: 'serve'` means the plugin is not part of `vite build` at all. There
 *    is no production code path to disable, because there is no production code.
 *
 * 3. The site itself never imports this file. It lives outside `app/`, so it
 *    cannot be pulled into the client or worker bundle by an accidental import.
 *
 * Everything it writes is inside `content/` and is committed to git, so every
 * edit the maintainer makes in the studio shows up in `git diff` and can be reverted with
 * `git checkout`. That is the undo button, and it is the reason the write
 * surface is deliberately narrow.
 */
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Plugin, ViteDevServer} from 'vite';
import type {IncomingMessage, ServerResponse} from 'node:http';

/** URL prefix the studio talks to. Underscored so it cannot collide with a route. */
const API = '/__studio';

/**
 * The only directory the studio may write into, relative to the repo root.
 *
 * A path allowlist is the whole security model here. The endpoint is bound to
 * localhost in dev, but "it is only dev" is not a reason to accept a traversal
 * bug: this process runs with the maintainer's permissions on their own machine, and a
 * malicious page in his browser can POST to localhost. Every write resolves the
 * target and confirms it is still inside this directory afterwards.
 */
const WRITE_ROOT = 'content';

/** Hostnames that mean "this machine". */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The one file outside `content/` the studio may write.
 *
 * The hero scene's tunables live in `public/models/<design>/studio.json`,
 * because the asset pipeline (`scripts/hero-assets/build-hero.mjs`) drops the
 * GLB and its settings side by side, and `HeroDroneScene` fetches the file from
 * there at runtime. Moving it into `content/` to satisfy a tidy allowlist would
 * break that pipeline for no gain.
 *
 * So it is an exact-shape exception, not a second root: one fixed directory
 * prefix, one path segment for the design name with no separators or dots in
 * it, and one fixed filename. Nothing else under `public/` is reachable.
 */
const HERO_SETTINGS = /^public\/models\/[A-Za-z0-9_-]+\/studio\.json$/;

/**
 * Markdown documents: the legal pages, the newsletter posts and the learn
 * articles.
 *
 * Same exact-shape reasoning as the hero settings: fixed directory prefixes,
 * a locale segment from a closed set for legal pages, one filename with no
 * separators. The storefront is the authoring source for all of them.
 */
const DOC_PATTERNS = [
  /^app\/content\/legal\/(en|nl|fr)\/[A-Za-z0-9_-]+\.md$/,
  /^app\/content\/learn\/[A-Za-z0-9_-]+\.md$/,
  /^content\/posts\/[A-Za-z0-9_-]+\.md$/,
];
const isDoc = (rel: string) => DOC_PATTERNS.some((re) => re.test(rel));

/** Resolve a Markdown document path, or null. */
function resolveDocPath(repoRoot: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  if (!isDoc(rel)) return null;
  const abs = path.resolve(repoRoot, ...rel.split('/'));
  return abs === path.resolve(repoRoot, rel) ? abs : null;
}

/** Which root a request's path is checked against. */
function rootFor(rel: string): string {
  if (HERO_SETTINGS.test(rel) || isDoc(rel)) return path.posix.dirname(rel);
  return WRITE_ROOT;
}

/** Reject anything that is not a plain .json file under WRITE_ROOT. */
function resolveWritePath(repoRoot: string, rel: string): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  // Reject absolute paths, NUL bytes and Windows drive letters before resolving.
  if (rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    return null;
  }
  if (!rel.endsWith('.json')) return null;

  if (HERO_SETTINGS.test(rel)) {
    const abs = path.resolve(repoRoot, rel);
    // Re-derive the expected path from the matched name rather than trusting
    // the resolution: belt and braces against a future edit loosening the regex.
    const expected = path.resolve(repoRoot, ...rel.split('/'));
    return abs === expected ? abs : null;
  }

  const root = path.resolve(repoRoot, WRITE_ROOT);
  const abs = path.resolve(root, rel);
  // The containment check has to happen AFTER resolution, because that is what
  // collapses `..` segments. Compare against root + separator so a sibling
  // directory named `contentX` cannot pass as `content`.
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/**
 * Second containment check, this time against the real filesystem.
 *
 * `resolveWritePath` is purely lexical: it collapses `..` but has no idea what
 * a path component actually IS. A directory symlink under `content/` therefore
 * escapes it completely - reads leak arbitrary files, writes land outside the
 * repo, and the success response reports a path inside `content/` that is not
 * where the bytes went. There is no such symlink today, but the repo root
 * already carries one (`drafts`), so the pattern is one `ln -s` away.
 *
 * Resolves the deepest existing ancestor, because the target file itself may
 * legitimately not exist yet on a first write.
 */
async function realContained(
  repoRoot: string,
  abs: string,
  rootRel: string = WRITE_ROOT,
): Promise<boolean> {
  const root = await fs.realpath(path.resolve(repoRoot, rootRel)).catch(() => null);
  if (!root) return false;
  let probe = abs;
  for (;;) {
    const real = await fs.realpath(probe).catch(() => null);
    if (real) {
      return real === root || real.startsWith(root + path.sep);
    }
    const parent = path.dirname(probe);
    // Ran out of path without finding anything real: nothing to trust.
    if (parent === probe) return false;
    probe = parent;
  }
}

async function readBody(req: IncomingMessage, limitBytes = 2_000_000) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Bound the body so a runaway client cannot exhaust memory.
    if (size > limitBytes) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // The studio is same-origin with the dev server. No CORS headers on purpose:
  // another origin should not be able to read the response.
  res.setHeader('cache-control', 'no-store');
  res.end(json);
}

/**
 * Serialise writes per target path.
 *
 * Rename-over-temp is only atomic against a CRASH. It does nothing about two
 * overlapping writes, and the first version of this file made that worse by
 * deriving the temp name from the target: both writers opened the same temp
 * file with O_TRUNC, the longer one's tail survived past the shorter one's
 * terminator, and the loser's rename hit ENOENT because the winner had already
 * moved the file away. Measured on 200 concurrent double-saves of one file:
 * 151 rounds left syntactically invalid JSON on disk and 198 returned a 500 for
 * a write that had partly landed.
 *
 * That is not theoretical for this studio. Cmd-S twice in quick succession, or
 * a token drag firing saves back to back, is exactly the shape. A corrupt
 * content file breaks the `import.meta.glob` and takes down every page that
 * imports it, and it fails the production build if committed.
 *
 * So: one promise chain per path, and a temp name nothing else can collide
 * with. Note macOS is case-insensitive, so the chain is keyed on the lowercased
 * path - otherwise `copy/A.json` and `copy/a.json` would be two chains writing
 * one file.
 */
const writeChains = new Map<string, Promise<unknown>>();

async function writeAtomic(abs: string, text: string) {
  const key = abs.toLowerCase();
  const prev = writeChains.get(key) ?? Promise.resolve();
  const next = prev.then(
    async () => {
      await fs.mkdir(path.dirname(abs), {recursive: true});
      const tmp = `${abs}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, text, 'utf8');
        await fs.rename(tmp, abs);
      } catch (err) {
        // Never leave a stray temp file behind on a failed write.
        await fs.rm(tmp, {force: true}).catch(() => {});
        throw err;
      }
    },
    // A failed predecessor must not poison the queue for later writes.
    () => undefined,
  );
  writeChains.set(key, next.catch(() => undefined));
  await next;
}

/**
 * Keep the hero tuning tool out of the deployed site.
 *
 * `public/models/<design>/_studio.html` sits in `publicDir`, so Vite copies it
 * verbatim into `dist/client` and it would be served at
 * `opendrone.be/models/od3/_studio.html`. That predates the studio, but it is
 * still a developer tool on a public URL, and it now carries a save button
 * pointing at an endpoint that only exists in dev. The save would just 404, so
 * this is not a hole; it is a tool nobody outside the workshop should be handed.
 *
 * Deleting from the output rather than moving the file keeps the dev URL, the
 * asset pipeline that drops it beside its GLB, and `docs/hero-studio.md` all
 * working unchanged.
 */
export function heroStudioExcludePlugin(): Plugin {
  return {
    name: 'opendrone-studio-exclude-hero-tool',
    apply: 'build',
    async closeBundle() {
      const dir = path.resolve(process.cwd(), 'dist/client/models');
      const designs = await fs.readdir(dir).catch(() => [] as string[]);
      for (const d of designs) {
        const target = path.join(dir, d, '_studio.html');
        await fs
          .rm(target, {force: true})
          .then(() => undefined)
          .catch(() => undefined);
      }
    },
  };
}

export function studioPlugin(): Plugin {
  let repoRoot = process.cwd();

  return {
    name: 'opendrone-studio',
    apply: 'serve',
    configResolved(config) {
      repoRoot = config.root;
    },
    configureServer: {
      // `pre` puts this ahead of the Cloudflare plugin's workerd proxy, and the
      // plugin is also listed before `cloudflare()` in the plugins array: Vite
      // keeps registration order within the same `order` bucket.
      order: 'pre',
      handler(server: ViteDevServer) {
        server.middlewares.use((req, res, next) => {
          const url = req.url ?? '';
          if (!url.startsWith(`${API}/`)) return next();

          /**
           * Three checks, because the obvious one is not enough.
           *
           * The first version only inspected Origin, compared it by hostname
           * alone, and accepted a request that had no Origin at all. That let
           * any page on any other localhost port write into `content/`, and it
           * accepted exactly the request shape a DNS-rebinding attack produces:
           * a cross-origin `<form enctype="text/plain">` POST is same-origin
           * from the browser's point of view after rebinding, and such
           * navigations do not reliably carry an Origin header.
           *
           * So: Host must be loopback (defeats rebinding, which relies on a
           * non-loopback Host), Origin if present must match this exact server
           * including port, and the body must be declared JSON, which no
           * simple-request form can send without triggering a preflight.
           */
          const host = (req.headers.host ?? '').split(':')[0];
          if (!LOOPBACK.has(host)) {
            return send(res, 403, {error: 'non-loopback host refused'});
          }

          const origin = req.headers.origin;
          if (origin) {
            let ok = false;
            try {
              const u = new URL(origin);
              ok = LOOPBACK.has(u.hostname) && u.host === req.headers.host;
            } catch {
              ok = false;
            }
            if (!ok) return send(res, 403, {error: 'cross-origin write refused'});
          }

          if (req.method === 'POST') {
            const ct = (req.headers['content-type'] ?? '').split(';')[0].trim();
            if (ct !== 'application/json') {
              return send(res, 415, {error: 'expected content-type: application/json'});
            }
          }

          void handle(req, res, url, repoRoot, server);
          return undefined;
        });
      },
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  repoRoot: string,
  server: ViteDevServer,
) {
  const route = url.split('?')[0].slice(API.length);

  try {
    if (route === '/read' && req.method === 'POST') {
      const {file} = JSON.parse(await readBody(req)) as {file?: string};
      const abs = resolveWritePath(repoRoot, file ?? '');
      if (!abs) return send(res, 400, {error: 'bad path'});
      if (!(await realContained(repoRoot, abs, rootFor(file ?? '')))) {
        return send(res, 400, {error: 'path escapes its allowed root'});
      }
      try {
        const text = await fs.readFile(abs, 'utf8');
        return send(res, 200, {ok: true, data: JSON.parse(text)});
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return send(res, 404, {error: 'not found'});
        }
        throw err;
      }
    }

    if (route === '/write' && req.method === 'POST') {
      const {file, data} = JSON.parse(await readBody(req)) as {
        file?: string;
        data?: unknown;
      };
      const abs = resolveWritePath(repoRoot, file ?? '');
      if (!abs) return send(res, 400, {error: 'bad path'});
      if (!(await realContained(repoRoot, abs, rootFor(file ?? '')))) {
        return send(res, 400, {error: 'path escapes its allowed root'});
      }
      if (data === undefined) return send(res, 400, {error: 'no data'});
      // A copy file's basename becomes the page segment of every id on it, and
      // `splitId` splits an id on its FIRST dot. `nav.cart.json` would register
      // as page "nav.cart" while every lookup resolved page "nav", so the file
      // would be silently unreadable by the site. Refuse to create one.
      // Only copy files: their basename becomes the page segment of every id
      // on them, and `splitId` splits an id on its FIRST dot, so `nav.cart.json`
      // would register as page "nav.cart" while every lookup resolved "nav".
      // Other content files are read whole and have no such constraint.
      if ((file ?? '').startsWith('copy/')) {
        const base = path.basename(abs, '.json');
        if (!base || base.includes('.')) {
          return send(res, 400, {error: 'copy file name must not contain a dot'});
        }
      }

      // Two trailing newline conventions in one repo is a diff-noise generator.
      // Match what Prettier writes for JSON: two-space indent, trailing newline.
      const text = `${JSON.stringify(data, null, 2)}\n`;
      await writeAtomic(abs, text);

      // Vite watches `content/`, so the importing module invalidates and the
      // page hot-reloads on its own. This is belt and braces for editors whose
      // atomic-rename shape the watcher misses.
      const mod = server.moduleGraph.getModulesByFile(abs);
      if (mod) for (const m of mod) server.moduleGraph.invalidateModule(m);

      return send(res, 200, {ok: true, file: path.relative(repoRoot, abs)});
    }

    if (route === '/list' && req.method === 'GET') {
      const root = path.resolve(repoRoot, WRITE_ROOT);
      const out: string[] = [];
      const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, {withFileTypes: true});
        for (const e of entries) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) await walk(abs);
          else if (e.name.endsWith('.json')) {
            out.push(path.relative(root, abs));
          }
        }
      };
      await walk(root);
      out.sort();
      return send(res, 200, {ok: true, files: out});
    }

    /**
     * Every image the site could reference, from `public/`.
     *
     * Read-only on purpose. The studio can point a page at a different picture,
     * which is the common edit; it cannot upload or delete one. Adding an image
     * means dropping a file in `public/` and it appears here, which keeps binary
     * assets going through git the same way everything else does.
     */
    /** Read a Markdown document as raw text. */
    if (route === '/read-text' && req.method === 'POST') {
      const {file} = JSON.parse(await readBody(req)) as {file?: string};
      const abs = resolveDocPath(repoRoot, file ?? '');
      if (!abs) return send(res, 400, {error: 'bad path'});
      if (!(await realContained(repoRoot, abs, rootFor(file ?? ''))))
        return send(res, 400, {error: 'path escapes its allowed root'});
      try {
        return send(res, 200, {
          ok: true,
          text: await fs.readFile(abs, 'utf8'),
        });
      } catch {
        return send(res, 404, {error: 'not found'});
      }
    }

    /** Write a Markdown document. */
    if (route === '/write-text' && req.method === 'POST') {
      const {file, text} = JSON.parse(await readBody(req)) as {
        file?: string;
        text?: string;
      };
      const abs = resolveDocPath(repoRoot, file ?? '');
      if (!abs) return send(res, 400, {error: 'bad path'});
      if (typeof text !== 'string') return send(res, 400, {error: 'no text'});
      if (!(await realContained(repoRoot, abs, rootFor(file ?? ''))))
        return send(res, 400, {error: 'path escapes its allowed root'});
      await writeAtomic(abs, text);
      return send(res, 200, {ok: true, file});
    }

    /** Every Markdown document, grouped: legal per locale, posts, learn. */
    if (route === '/docs' && req.method === 'GET') {
      const out: Array<{file: string; group: string; name: string}> = [];
      const add = async (dir: string, group: string) => {
        const names = await fs.readdir(path.resolve(repoRoot, dir)).catch(() => [] as string[]);
        for (const n of names.sort()) {
          const rel = `${dir}/${n}`;
          if (isDoc(rel)) out.push({file: rel, group, name: n});
        }
      };
      for (const locale of ['en', 'nl', 'fr']) {
        await add(`app/content/legal/${locale}`, `Legal ${locale.toUpperCase()}`);
      }
      await add('content/posts', 'Newsletter');
      await add('app/content/learn', 'Learn');
      return send(res, 200, {ok: true, docs: out});
    }

    if (route === '/media' && req.method === 'GET') {
      const root = path.resolve(repoRoot, 'public');
      const out: Array<{path: string; bytes: number}> = [];
      const walk = async (dir: string) => {
        const entries = await fs.readdir(dir, {withFileTypes: true});
        for (const e of entries) {
          const abs = path.join(dir, e.name);
          // Skip the model folders: GLBs are a build-pipeline output, not
          // pickable art, and their sidecars are handled by the Hero tab.
          if (e.isDirectory()) {
            if (e.name === 'models' || e.name.startsWith('.')) continue;
            await walk(abs);
          } else if (/\.(svg|png|jpe?g|webp|avif|gif)$/i.test(e.name)) {
            const st = await fs.stat(abs);
            out.push({
              // The URL the site would use, which is the value a copy key holds.
              path: `/${path.relative(root, abs).split(path.sep).join('/')}`,
              bytes: st.size,
            });
          }
        }
      };
      await walk(root);
      out.sort((a, b) => a.path.localeCompare(b.path));
      return send(res, 200, {ok: true, images: out});
    }

    /**
     * Where an image is referenced, so a swap is not made blind.
     *
     * Computed on demand rather than for the whole list: the answer needs a
     * scan of `app/` and `content/`, and doing that for every image on every
     * load would make the tab slow for information nobody asked for yet.
     */
    if (route === '/usage' && req.method === 'POST') {
      const {needle} = JSON.parse(await readBody(req)) as {needle?: string};
      if (typeof needle !== 'string' || needle.length < 2) {
        return send(res, 400, {error: 'bad needle'});
      }
      const hits: string[] = [];
      const scan = async (dir: string) => {
        const entries = await fs.readdir(dir, {withFileTypes: true}).catch(() => []);
        for (const e of entries) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            await scan(abs);
          } else if (/\.(tsx?|json|css|mdx?)$/i.test(e.name)) {
            const text = await fs.readFile(abs, 'utf8').catch(() => '');
            if (text.includes(needle)) {
              hits.push(path.relative(repoRoot, abs));
            }
          }
        }
      };
      await scan(path.resolve(repoRoot, 'app'));
      await scan(path.resolve(repoRoot, 'content'));
      hits.sort();
      return send(res, 200, {ok: true, files: hits});
    }

    return send(res, 404, {error: 'no such studio endpoint'});
  } catch (err) {
    // Surface the real reason in dev. This endpoint never runs in production,
    // so there is no information-disclosure trade to make here.
    return send(res, 500, {error: String((err as Error)?.message ?? err)});
  }
}
