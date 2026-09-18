/**
 * Live funding overlay: parsing and merging for the lighter Odoo feed
 * `GET /incutec/funding.json` (module `incutec_catalog_api`).
 *
 * Two wire schemas are accepted, because the feed moves to schema 2 on the
 * Odoo side independently of this deploy:
 *  - schema 1: `funding[<handle>] = {units_funded, pct, state}`;
 *  - schema 2: the same three fields plus `target_units`, `date_open`,
 *    `date_deadline`, `backers`, `amount_funded` and `currency`.
 * The document wrapper (`{schema, updated_at, max_age, funding}`) is the
 * same in both, and the schema number itself is not read: an entry is
 * accepted on the three fields every schema carries, and each schema-2
 * field is validated on its own and dropped when it is missing or
 * malformed. A schema-1 feed therefore parses exactly as it did before,
 * and a schema-2 feed reaching an older build is still readable.
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

/**
 * The live fields this feed is allowed to refresh.
 *
 * `unitsFunded` and `state` are the schema-1 core and are always present.
 * Everything below is schema 2 and reads null when the feed omits it, so
 * the merge can tell "the feed does not carry this" apart from "the feed
 * says zero".
 */
export type FundingOverlayEntry = {
  unitsFunded: number;
  state: 'open' | 'funded' | 'missed';
  /** Unit target, when the live feed restates it. Null on schema 1. */
  targetUnits?: number | null;
  /** ISO day the campaign opened, or null. */
  dateOpen?: string | null;
  /** ISO day the campaign closes, or null. */
  dateDeadline?: string | null;
  /** Distinct backers, or null. */
  backers?: number | null;
  /** Money pledged so far, in `currency`, or null. */
  amountFunded?: number | null;
  /** ISO code for `amountFunded`, or null. */
  currency?: string | null;
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
    // Schema 2. Each field stands or falls on its own: a feed that mixes a
    // good backer count with a broken amount keeps the count. A target of
    // zero or less is not a campaign and is dropped rather than allowed to
    // divide the meter by zero.
    targetUnits: positive(f.target_units),
    dateOpen: isoDay(f.date_open),
    dateDeadline: isoDay(f.date_deadline),
    backers: counted(f.backers),
    amountFunded: counted(f.amount_funded),
    currency: typeof f.currency === 'string' && f.currency ? f.currency : null,
  };
}

/** A finite number at or above zero, else null. */
function counted(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/** A finite number above zero, else null. */
function positive(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** A non-empty date string, else null. Shape checking is the reader's job
 *  (`fundingDeadlineText`, `fundingDaysLeft`), which already rejects a day
 *  that does not parse. */
function isoDay(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw : null;
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
        funding: mergeEntry(current, live),
      };
    }),
  };
}

/**
 * One catalog campaign plus one live entry.
 *
 * `unitsFunded` and `state` always come from the feed: refreshing those is
 * what this overlay exists for. Every schema-2 field is applied only when
 * the feed actually carries it, so a schema-1 feed (or a schema-2 feed
 * that omits a field) leaves the catalog's own value standing instead of
 * blanking it to null.
 */
function mergeEntry(
  current: CatalogFunding,
  live: FundingOverlayEntry,
): CatalogFunding {
  const merged: CatalogFunding = {
    ...current,
    unitsFunded: live.unitsFunded,
    state: live.state,
  };
  if (live.targetUnits != null) merged.targetUnits = live.targetUnits;
  if (live.dateOpen != null) merged.dateOpen = live.dateOpen;
  if (live.dateDeadline != null) merged.dateDeadline = live.dateDeadline;
  if (live.backers != null) merged.backers = live.backers;
  if (live.amountFunded != null) merged.amountFunded = live.amountFunded;
  if (live.currency != null) merged.currency = live.currency;
  return merged;
}
