/**
 * Plausible custom-event helper.
 *
 * The root layout loads the legacy hosted script
 * `script.tagged-events.revenue.js` (tagged-events → custom events with
 * props, revenue → monetary values on events). Manual events go through
 * `window.plausible()`; this wrapper is SSR-safe (no-op on the server)
 * and installs the official queue stub so events fired before the
 * deferred script finishes loading are replayed on init - the script
 * drains `window.plausible.q` when it boots.
 *
 * Keep event names and prop values LOW-CARDINALITY: Plausible breaks
 * down by exact string, so `source: 'youtube'` is a dimension while a
 * free-form URL would be dashboard soup. Canonical sources live in
 * drafts/utm-conventions.md.
 */

export type PlausibleProps = Record<string, string | number | boolean>;

/** Amount in major currency units (euros, not cents), currency ISO 4217. */
export type PlausibleRevenue = {currency: string; amount: number};

export type PlausibleEventOptions = {
  props?: PlausibleProps;
  revenue?: PlausibleRevenue;
};

type PlausibleFn = ((name: string, opts?: PlausibleEventOptions) => void) & {
  q?: unknown[][];
};

type PlausibleWindow = Window & {plausible?: PlausibleFn};

/**
 * Fire a Plausible custom event. Safe to call anywhere: no-ops during SSR
 * and never throws - analytics must not take down a storefront flow.
 */
export function trackEvent(name: string, opts?: PlausibleEventOptions): void {
  if (typeof window === 'undefined') return;
  const w = window as PlausibleWindow;
  if (!w.plausible) {
    // Official queue stub: buffered calls are replayed by the script via
    // `plausible.apply(this, q[i])`, so pushing arg arrays is equivalent
    // to the snippet's `arguments` objects.
    const stub: PlausibleFn = (...args: unknown[]) => {
      (stub.q = stub.q ?? []).push(args);
    };
    w.plausible = stub;
  }
  try {
    w.plausible(name, opts);
  } catch (err) {
    console.warn('[growth/plausible] trackEvent failed', err);
  }
}
