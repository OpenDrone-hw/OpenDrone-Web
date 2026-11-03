/**
 * The destination a Ship to switch is moving to, while it is in flight.
 *
 * A switch posts to /api/shopify/cart-country (cookie, Shopify cart country,
 * a fresh catalog to re-plan the lines), then React Router reads every loader
 * again (the cart loader re-plans with another fresh catalog). That is 1 to 6
 * seconds in which the select already shows the new country but the top bar
 * and the cart's Checkout still follow the old one. The picked country is
 * held here from the change until the loaders have returned, and the bar,
 * the ship lines and the cart's destination gate read it first, so they
 * follow at once. Checkout stays disabled while the switch is pending (the
 * cart's `pending`), so nothing is bought on the optimistic state; the loader
 * data that lands is the same country, so nothing flips back.
 *
 * Client-only state: the server snapshot is always null, so SSR and
 * hydration agree.
 */
import {useSyncExternalStore} from 'react';

let pending: string | null = null;
const listeners = new Set<() => void>();

export function setPendingShipTo(country: string | null): void {
  const next = country?.trim().toUpperCase() || null;
  if (next === pending) return;
  pending = next;
  for (const listener of listeners) listener();
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
 *  moving to and that country's region, the locale unchanged. */
export function withPendingShipTo<G extends {country: string | null; region: string; locale: string}>(
  geo: G | null | undefined,
  pendingCountry: string | null,
  regionOf: (country: string) => G['region'],
): G | null | undefined {
  if (!geo || !pendingCountry || pendingCountry === geo.country) return geo;
  return {...geo, country: pendingCountry, region: regionOf(pendingCountry)};
}
