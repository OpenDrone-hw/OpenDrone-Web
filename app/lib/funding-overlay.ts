/**
 * Live funding overlay: parsing and merging for the lighter Odoo feed
 * `GET /incutec/funding.json` (module `incutec_catalog_api`), contract
 * shape `{schema, updated_at, max_age, funding: {<handle>: {units_funded,
 * pct, state}}}`.
 *
 * The catalog (`app/lib/catalog.ts`) is cached 5 minutes and stays the
 * source of every campaign's existence, target and deadline. This feed is
 * cached 60 seconds and only ever refreshes `unitsFunded`/`state` on a
 * campaign the catalog already published; it can never create a campaign
 * and can never resurrect one the catalog says is `draft` or `cancelled`.
 *
 * Kept pure and bundler-free (relative imports, no worker APIs) so the
 * node:test suites can load it without Vite, same constraint as
 * `catalog.ts`. The fetching and caching half lives in
 * `app/lib/funding-overlay-client.ts`.
 */

// Relative import on purpose: node:test runs this module without Vite, so
// the `~` alias is not available here.
import type {Catalog, CatalogFunding} from './catalog.ts';

/** The live fields this feed is allowed to refresh. */
export type FundingOverlayEntry = {
  unitsFunded: number;
  state: 'open' | 'funded' | 'missed';
};

export type FundingOverlay = {
  updatedAt: string | null;
  /** By product handle. A handle with no live entry is left untouched. */
  funding: Record<string, FundingOverlayEntry>;
};

/** What a missing, unreachable, or not-yet-deployed feed degrades to. */
export const EMPTY_FUNDING_OVERLAY: FundingOverlay = {
  updatedAt: null,
  funding: {},
};

const OVERLAY_STATES: ReadonlySet<string> = new Set(['open', 'funded', 'missed']);

/**
 * One `funding[<handle>]` entry, or `undefined` to drop it. Strict on
 * purpose: this feed is optional and cosmetic, so a malformed entry is
 * dropped rather than let a bad number or an unknown state reach a
 * progress bar (`width: NaN%`, `aria-valuenow="NaN"`, or a state the meter
 * has no copy for).
 */
function normalizeEntry(raw: unknown): FundingOverlayEntry | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const f = raw as Record<string, unknown>;
  if (
    typeof f.units_funded !== 'number' ||
    !Number.isFinite(f.units_funded) ||
    f.units_funded < 0 ||
    // `pct` rides along for contract compatibility with the wire shape but
    // is never used for display (see fundingPct in funding.ts); it is
    // still range-checked so a feed that is otherwise broken is rejected
    // here rather than partially trusted.
    typeof f.pct !== 'number' ||
    !Number.isFinite(f.pct) ||
    f.pct < 0 ||
    typeof f.state !== 'string' ||
    !OVERLAY_STATES.has(f.state)
  ) {
    return undefined;
  }
  return {
    unitsFunded: f.units_funded,
    state: f.state as FundingOverlayEntry['state'],
  };
}

/**
 * Accept a parsed JSON body as a funding overlay. Never throws: a
 * non-object body, a missing/malformed `funding` map, or any per-handle
 * entry that fails validation all degrade to an empty (or partially
 * empty) overlay rather than fail the page. The caller treats an empty
 * overlay exactly like a missing, slow, or 404 endpoint: the catalog's
 * own numbers stand.
 */
export function parseFundingOverlay(body: unknown): FundingOverlay {
  if (!body || typeof body !== 'object') return EMPTY_FUNDING_OVERLAY;
  const b = body as Record<string, unknown>;
  if (!b.funding || typeof b.funding !== 'object') return EMPTY_FUNDING_OVERLAY;

  const funding: Record<string, FundingOverlayEntry> = {};
  for (const [handle, raw] of Object.entries(b.funding as Record<string, unknown>)) {
    const entry = normalizeEntry(raw);
    if (entry) funding[handle] = entry;
  }

  return {
    updatedAt: typeof b.updated_at === 'string' ? b.updated_at : null,
    funding,
  };
}

/** States the catalog may already carry that a buyer is allowed to see. */
function isPublicFundingState(
  state: CatalogFunding['state'],
): state is 'open' | 'funded' | 'missed' {
  return state === 'open' || state === 'funded' || state === 'missed';
}

/**
 * Overlay live `unitsFunded`/`state` onto a catalog, by product handle.
 *
 * Only touches a product that already carries a `funding` object from the
 * catalog, and only one already in a public state (`open`/`funded`/
 * `missed`): the overlay never creates a campaign a product doesn't have,
 * and never resurrects one the catalog says is `draft` or `cancelled`.
 * Every other field of `CatalogFunding` (target, deadline, explainer)
 * passes through from the catalog untouched.
 */
export function mergeFundingOverlay(
  catalog: Catalog,
  overlay: FundingOverlay,
): Catalog {
  if (Object.keys(overlay.funding).length === 0) return catalog;
  return {
    ...catalog,
    products: catalog.products.map((product) => {
      const current = product.funding;
      if (!current || !isPublicFundingState(current.state)) return product;
      const live = overlay.funding[product.handle];
      if (!live) return product;
      return {
        ...product,
        funding: {...current, unitsFunded: live.unitsFunded, state: live.state},
      };
    }),
  };
}
