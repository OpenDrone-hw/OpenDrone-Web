/**
 * Dev-server-only overrides that point the Discord and Shopify Admin calls
 * at the local sandbox (`npm run support:sandbox`).
 *
 * Every caller gates on `import.meta.env.DEV` inline, at the call site:
 * a production build replaces it with the literal `false`, the minifier
 * drops the branch, and the variable names never reach the Worker
 * (dev-overrides.test.ts scans a build for them). Plain Node, the test
 * runner, has no `import.meta.env` and takes the production path.
 */

/** The sandbox URL if `value` is a localhost URL, else null. Call only behind `import.meta.env.DEV`. */
export function devOverride(value: string | undefined): string | null {
  const v = value?.trim();
  return v && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(v) ? v.replace(/\/+$/, '') : null;
}
