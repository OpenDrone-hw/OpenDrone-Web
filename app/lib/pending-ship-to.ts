/**
 * The destination a Ship to switch is moving to, while it is in flight.
 *
 * A switch posts to /api/shopify/cart-country (cookie, Shopify cart country,
 * a fresh catalog to re-plan the lines), then React Router reads every loader
 * again (the cart loader re-plans with another fresh catalog). That is 1 to 6
 * seconds in which the select already shows the new country but the top bar
 * and the cart's Checkout still follow the old one. The picked country is
 * held here from the change until the root loader returns new data, and the
 * bar, the ship lines and the cart's destination gate read it first, so they
 * follow at once.
 *
 * Display only: every request (add, checkout) still sends the confirmed
 * country, and Checkout and Add stay disabled while a switch is pending.
 * Cleared:
 * - by `reconcilePendingShipTo` once the root loader data is no longer the data
 *   the switch started from (the loaders returned: the same country, so
 *   nothing flips back, or another one, which then shows);
 * - at once when the switch fails;
 * - after PENDING_SHIP_TO_TIMEOUT_MS, whatever happens (a stuck switch).
 *
 * Client-only state: the server snapshot is always null, so SSR and
 * hydration agree.
 */
import {useSyncExternalStore} from 'react';

/** A switch that has not settled by then is dropped. */
export const PENDING_SHIP_TO_TIMEOUT_MS = 15_000;

let pending: string | null = null;
/** The root loader data the switch started from (identity compared). */
let baseline: unknown = undefined;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Start (a country and the current root loader data) or clear (null) the pending switch. */
export function setPendingShipTo(country: string | null, rootData?: unknown): void {
  const next = country?.trim().toUpperCase() || null;
  if (timer) clearTimeout(timer);
  timer = null;
  baseline = next ? rootData : undefined;
  if (next) {
    timer = setTimeout(() => setPendingShipTo(null), PENDING_SHIP_TO_TIMEOUT_MS);
  }
  if (next === pending) return;
  pending = next;
  emit();
}

/** Clear the pending switch once the root loader has returned new data. */
export function reconcilePendingShipTo(rootData: unknown): void {
  if (pending !== null && rootData !== baseline) setPendingShipTo(null);
}

export function getPendingShipTo(): string | null {
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The in-flight destination, or null (always null on the server). */
export function usePendingShipTo(): string | null {
  return useSyncExternalStore(subscribe, getPendingShipTo, () => null);
}

/** The visitor's geo with an in-flight destination applied: the country it is
 *  moving to and that country's region, the locale unchanged. A visitor whose
 *  IP country is blocked stays there (`ipBlocked`): no switch moves them, so
 *  the pending country is not shown (it would flip back). */
export function withPendingShipTo<G extends {country: string | null; region: string; locale: string}>(
  geo: G | null | undefined,
  pendingCountry: string | null,
  regionOf: (country: string) => G['region'],
  ipBlocked = false,
): G | null | undefined {
  if (!geo || !pendingCountry || ipBlocked || pendingCountry === geo.country) return geo;
  return {...geo, country: pendingCountry, region: regionOf(pendingCountry)};
}
