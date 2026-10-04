/**
 * Plausible client: the site script's queue stub, its init call and the
 * custom-event helper.
 *
 * The root layout loads the site-specific script
 * `https://plausible.io/js/pa-<id>.js` on opendrone.be only, after the
 * inline `PLAUSIBLE_SNIPPET` below. Which optional measurements run
 * (outbound links, file downloads, form submissions) is set in the
 * Plausible dashboard and baked into that script; `initPlausible` passes
 * no option for them, because an init option overrides the dashboard.
 *
 * Init waits for hydration (`initPlausible`, called from root.tsx after
 * `captureAttribution`), so the first pageview already carries the
 * session's first-touch `source` and `ref` as custom properties. The
 * script inits on load when the stub's `init` already ran, or right away
 * when it is called after the script loaded; events fired before init
 * wait in `plausible.q` and are replayed by the script.
 *
 * Keep event names and prop values LOW-CARDINALITY: Plausible breaks
 * down by exact string, so `source: 'youtube'` is a dimension while a
 * free-form URL would be dashboard soup.
 */
import {attributionProps} from './attribution.ts';

export type PlausibleProps = Record<string, string | number | boolean>;

/** Amount in major currency units (euros, not cents), currency ISO 4217. */
export type PlausibleRevenue = {currency: string; amount: number};

export type PlausibleEventOptions = {
  props?: PlausibleProps;
  revenue?: PlausibleRevenue;
};

export type PlausibleInitOptions = {
  customProperties?: (eventName: string) => PlausibleProps;
};

type PlausibleFn = ((name: string, opts?: PlausibleEventOptions) => void) & {
  q?: unknown[][];
  o?: PlausibleInitOptions;
  init?: (opts?: PlausibleInitOptions) => void;
  /** Set by the loaded script once it has initialised. */
  l?: boolean;
};

type PlausibleWindow = {plausible?: PlausibleFn};

/** The site script; its id is public (it is in every page's HTML). */
export const PLAUSIBLE_SCRIPT_SRC = 'https://plausible.io/js/pa-ET4ElpR9OkKvE3U38an7k.js';

/**
 * Plausible's documented queue stub, without its trailing
 * `plausible.init()`: `initPlausible` makes that call after hydration.
 */
export const PLAUSIBLE_SNIPPET =
  'window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};';

function plausibleWindow(): PlausibleWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as PlausibleWindow);
}

/** The same stub as `PLAUSIBLE_SNIPPET`, for pages without the snippet. */
function installStub(w: PlausibleWindow): PlausibleFn {
  if (w.plausible) return w.plausible;
  const stub: PlausibleFn = (...args: unknown[]) => {
    (stub.q = stub.q ?? []).push(args);
  };
  stub.init = (opts) => {
    stub.o = opts ?? {};
  };
  w.plausible = stub;
  return stub;
}

/**
 * The revenue Plausible can record: amount rounded to cents, a positive
 * finite number, and a three-letter currency. Anything else is dropped
 * (the event still goes), so a missing or zero price never shows up as a
 * 0.00 conversion.
 */
export function plausibleRevenue(
  money: {amount: string | number; currency?: string; currencyCode?: string} | null | undefined,
  quantity = 1,
): PlausibleRevenue | undefined {
  if (!money) return undefined;
  const currency = (money.currency ?? money.currencyCode ?? '').toUpperCase();
  const amount = Math.round(Number(money.amount) * quantity * 100) / 100;
  if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(amount) || amount <= 0) return undefined;
  return {currency, amount};
}

/**
 * Init the site script once per page load, with the session's
 * first-touch `source` and `ref` as custom properties on every event,
 * pageviews included. Event props of the same name win. No-op off the
 * production host, where the snippet is not rendered.
 */
export function initPlausible(): void {
  const w = plausibleWindow();
  if (!w?.plausible?.init || w.plausible.l || w.plausible.o) return;
  try {
    w.plausible.init({customProperties: () => attributionProps()});
  } catch (err) {
    console.warn('[growth/plausible] init failed', err);
  }
}

/**
 * Fire a Plausible custom event. Safe to call anywhere: no-ops during SSR
 * and never throws - analytics must not take down a storefront flow.
 */
export function trackEvent(name: string, opts?: PlausibleEventOptions): void {
  const w = plausibleWindow();
  if (!w) return;
  const plausible = installStub(w);
  const revenue = plausibleRevenue(opts?.revenue);
  const sent: PlausibleEventOptions | undefined = opts
    ? {...(opts.props ? {props: opts.props} : {}), ...(revenue ? {revenue} : {})}
    : undefined;
  try {
    plausible(name, sent);
  } catch (err) {
    console.warn('[growth/plausible] trackEvent failed', err);
  }
}
