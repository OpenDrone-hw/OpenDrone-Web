import {execSync} from 'node:child_process';
import {defineConfig} from 'vite';
import {cloudflare} from '@cloudflare/vite-plugin';
import {reactRouter} from '@react-router/dev/vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import tailwindcss from '@tailwindcss/vite';
import {
  heroStudioExcludePlugin,
  studioPlugin,
} from './studio/vite-plugin-studio';

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
    // Strips the hero tuning tool out of the production client build; it sits
    // in publicDir, so Vite would otherwise serve it at a public URL.
    heroStudioExcludePlugin(),
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
