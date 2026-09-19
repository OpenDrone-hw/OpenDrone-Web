import type {Config} from '@react-router/dev/config';

/**
 * React Router configuration.
 *
 * These are the values the Hydrogen preset used to supply, written out now
 * that the app builds with plain React Router and the Cloudflare Vite plugin
 * (vite.config.ts): `app/` in, `dist/client` and `dist/server/index.js` out,
 * the paths wrangler.toml and wrangler.production.toml deploy.
 *
 * `v8_viteEnvironmentApi` is what the Cloudflare Vite plugin needs to run
 * the SSR environment in workerd. `v8_middleware` stays off: this app passes
 * a plain object (app/lib/context.ts) to React Router's handler, so loaders
 * take `context.env` / `context.catalog` directly and the AppLoadContext
 * type augmentation is what describes them.
 */
export default {
  appDirectory: 'app',
  buildDirectory: 'dist',
  ssr: true,
  future: {
    v8_middleware: false,
    v8_splitRouteModules: true,
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
