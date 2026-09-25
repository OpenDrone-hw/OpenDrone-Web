/**
 * One add to cart at a time, across every buy button on the page.
 *
 * Two adds sent back to back (the stack offer, then Pre-order, on a slow
 * phone) race on the session cart: the second can land on a cart that does
 * not hold the first yet, and a line drops. While one add runs, every other
 * buy button reads busy and refuses its submit.
 *
 * Bundler-free (no imports) so the node:test suites can load it.
 */

let inFlight = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Take the lock for one add. False when another add is still running. */
export function beginCartAdd(): boolean {
  if (inFlight) return false;
  inFlight = true;
  emit();
  return true;
}

/** Release the lock once the add has settled, success or failure. */
export function endCartAdd(): void {
  if (!inFlight) return;
  inFlight = false;
  emit();
}

export function isCartAddBusy(): boolean {
  return inFlight;
}

/** For useSyncExternalStore: call `listener` whenever the lock changes. */
export function subscribeCartAdd(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
