/**
 * STAGING BENCH SWITCH for /flash. The only thing in the code base that can
 * stand in for the *_VERIFIED hardware flags (targets.ts, am32-layout.ts),
 * and only for a private bench build. Every check is `CONST || stagingBenchEnabled()`;
 * the constants themselves stay false. It replaces ONLY the "not verified on
 * hardware yet" flags: target, MCU, name, chip-package and hash matching
 * still apply in full.
 *
 * True only when ALL hold:
 *   (a) the build was made with VITE_FLASH_STAGING_GATES=1 (build time: in a
 *       production build without the variable Vite replaces it with
 *       undefined, so (a) is statically false);
 *   (b) code runs in a browser page (`window` exists);
 *   (c) the page host is exactly `localhost`, `127.0.0.1` or `*.trycloudflare.com`.
 * Everything else, including opendrone.be, www.opendrone.be, *.workers.dev and
 * *.pages.dev, is refused. There is no argument, no URL parameter, no
 * storage key and no UI control that can turn it on.
 *
 * Nothing committed sets the variable (wrangler*.toml, .env*); the bench runs
 * a `VITE_FLASH_STAGING_GATES=1` build under `wrangler dev --local --config
 * wrangler.bench.toml`, which also serves the firmware files behind basic
 * auth (staging-serve.ts; see the bench sheet).
 * No imports on purpose: this file is reviewed on its own.
 */

/** Exact host allowlist: localhost, 127.0.0.1, or a name under trycloudflare.com. */
export function isStagingHost(hostname: unknown): boolean {
  if (typeof hostname !== 'string') return false;
  return hostname === 'localhost' || hostname === '127.0.0.1' || /^(?:[a-z0-9-]+\.)+trycloudflare\.com$/.test(hostname);
}

function envFlagSet(): boolean {
  // Same form as app/lib/builder/registry.ts: Vite inlines it; plain Node has no import.meta.env.
  return typeof import.meta.env !== 'undefined' && import.meta.env.VITE_FLASH_STAGING_GATES === '1';
}

function pageHost(): string | null {
  if (typeof window === 'undefined') return null;
  return window.location?.hostname ?? null;
}

export function stagingBenchEnabled(): boolean {
  if (!envFlagSet()) return false;
  const host = pageHost();
  return host !== null && isStagingHost(host);
}
