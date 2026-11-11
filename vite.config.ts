import {execSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {defineConfig, type Plugin} from 'vite';
import {cloudflare} from '@cloudflare/vite-plugin';
import {reactRouter} from '@react-router/dev/vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';
import {
  heroStudioExcludePlugin,
  studioPlugin,
} from './studio/vite-plugin-studio';
import {isContentJson, stripContent} from './app/lib/content-strip';
import {buildManifest} from './app/lib/editorial/manifest.ts';
import {
  FIRMWARE_STAGING_FORBIDDEN_OUTPUTS,
  FIRMWARE_STAGING_FORBIDDEN_SOURCES,
  STAGING_FIRMWARE_PREFIX,
  firmwareStagingBuildProblem,
} from './app/lib/flasher/staging-serve.ts';

// `$comment` notes and `hidden: true` entries in content/*.json are for
// editors only: a build drops them before Vite's JSON plugin turns the file
// into a module, so they never reach a client or Worker bundle.
function contentStripPlugin(): Plugin {
  return {
    name: 'opendrone:content-strip',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!isContentJson(id)) return null;
      return {code: JSON.stringify(stripContent(JSON.parse(code))), map: null};
    },
  };
}

// The editorial manifest (app/lib/editorial/manifest.ts): the content sources of this build and their hashes,
// computed once per build and served only by the flag-gated /api/editorial/* routes.
function editorialManifestPlugin(): Plugin {
  const id = 'virtual:editorial-manifest';
  let json: string | null = null;
  return {
    name: 'opendrone:editorial-manifest',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(source) {
      if (source !== `\0${id}`) return null;
      json ??= JSON.stringify(buildManifest({root: process.cwd()}));
      return `export default ${json};`;
    },
  };
}

// Review 3 (F2): unreleased bench firmware must never reach a deployable
// build. The build fails if public/firmware-staging/ exists (Vite would copy
// it into dist/client) or if any output holds a firmware-staging folder. The
// bench files live in .firmware-staging/ and only the bench Worker serves
// them, behind basic auth (app/lib/flasher/staging-serve.ts).
function firmwareStagingBuildGuardPlugin(): Plugin {
  // Paths come from Vite's resolved config, not the shell's working directory: a build started from
  // another directory (or with --config / a root argument) is checked just the same.
  let root = '';
  let publicDir: string | false = false;
  let outDirs: string[] = [];
  const fail = (found: string[]) => {
    const problem = firmwareStagingBuildProblem((p) => found.includes(p), found);
    if (problem) throw new Error(problem);
  };
  const checkSource = () => fail([...FIRMWARE_STAGING_FORBIDDEN_SOURCES.map((p) => join(root, p)), ...(publicDir ? [join(publicDir, 'firmware-staging')] : [])].filter((p) => existsSync(p)));
  const checkOutputs = () => fail(outDirs.map((d) => join(d, 'firmware-staging')).filter((p) => existsSync(p)));
  return {
    name: 'opendrone:firmware-staging-build-guard',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir;
      // The Cloudflare/React Router build writes per-environment outputs; check the configured outDir
      // and the usual client folders under it, plus the legacy fixed paths under the root.
      const out = resolve(root, config.build.outDir);
      outDirs = [...new Set([out, join(out, 'client'), ...FIRMWARE_STAGING_FORBIDDEN_OUTPUTS.map((p) => resolve(root, dirname(p)))])];
    },
    buildStart: checkSource,
    writeBundle: checkOutputs,
    closeBundle: checkOutputs,
  };
}

// The Vite dev server never serves /firmware-staging/* from public/ (an old
// local copy there would otherwise be served without auth or the staging env).
// Answered with 404 before Vite's static middleware.
function firmwareStagingDevRefusePlugin(): Plugin {
  return {
    name: 'opendrone:firmware-staging-dev-refuse',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        if (path === '/firmware-staging' || path.startsWith(STAGING_FIRMWARE_PREFIX)) {
          res.statusCode = 404;
          res.setHeader('Cache-Control', 'no-store');
          res.end('Not found');
          return;
        }
        next();
      });
    },
  };
}

// The footer's drawing title block names the build: the commit it was built
// from and the build date. No git (a source tarball) leaves the revision
// empty and the footer omits that cell.
function buildRevision(): string {
  try {
    return execSync('git rev-parse --short HEAD', {stdio: ['ignore', 'pipe', 'ignore']})
      .toString()
      .trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  // Worktrees that share one node_modules also share node_modules/.vite, and
  // two dev servers on one cache serve each other's stale deps. A dev server
  // started with VITE_CACHE_DIR=.vite-cache keeps its own (README "Test
  // support locally").
  cacheDir: process.env.VITE_CACHE_DIR || undefined,
  define: {
    __BUILD_REV__: JSON.stringify(buildRevision()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  plugins: [
    // MUST stay ahead of cloudflare(). The studio registers `configureServer`
    // with `order: 'pre'` so its write endpoint is answered by real Node
    // before any request is handed to the filesystem-less workerd sandbox.
    // It is `apply: 'serve'`, so it does not exist in a production build.
    studioPlugin(),
    firmwareStagingBuildGuardPlugin(),
    firmwareStagingDevRefusePlugin(),
    // Strips the hero tuning tool out of the production client build; it sits
    // in publicDir, so Vite would otherwise serve it at a public URL.
    heroStudioExcludePlugin(),
    contentStripPlugin(),
    editorialManifestPlugin(),
    tailwindcss(),
    // Runs server.ts in workerd in dev and builds it as the Worker entry
    // (dist/server/index.js). wrangler.toml supplies the compatibility date
    // for dev; `main` points the plugin at the source entry. Its staging
    // [vars] are dropped so dev reads env from .env alone and falls back to
    // the production defaults in code. Deploys pass --config explicitly
    // (.github/workflows), so they read the build output, not this.
    cloudflare({
      viteEnvironment: {name: 'ssr'},
      configPath: './wrangler.toml',
      config: (worker) => {
        worker.vars = {};
        return {main: './server.ts'};
      },
    }),
    reactRouter(),
    tsconfigPaths(),
  ],
  build: {
    // Allow a strict Content-Security-Policy
    // without inlining assets as base64:
    assetsInlineLimit: 0,
  },
  environments: {
    // The Worker bundle was minified under the Hydrogen CLI too; Vite leaves
    // SSR output unminified by default.
    ssr: {build: {minify: true}},
  },
  ssr: {
    optimizeDeps: {
      include: [
        'use-sync-external-store/shim/with-selector',
        'set-cookie-parser',
        'cookie',
        'react-router',
      ],
    },
  },
  server: {
    port: 3000,
    watch: {
      // The tsc incremental build info file is rewritten on every typegen
      // pass and macOS scatters metadata files; neither is source.
      ignored: [
        '**/tsconfig.tsbuildinfo',
        '**/.DS_Store',
        '**/.icloud',
        // Subagent worktrees live under .claude/worktrees inside the repo;
        // their branch churn (tsconfig writes force full reloads) storms the
        // watcher and has crashed the dev server. Never watch them.
        '**/.claude/**',
      ],
    },
  },
});
