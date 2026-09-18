/**
 * Funded pre-order progress: pure display helpers over `CatalogProduct.funding`
 * (contract field `funding`, see `erp/docs/storefront-contract.md`).
 *
 * Kept pure and bundler-free (relative imports, no worker APIs) so the
 * node:test suites can load it without Vite, the same constraint as
 * `app/lib/preorder.ts`. No UI here: components read these strings and
 * numbers and lay them out themselves.
 */

// Relative import on purpose: node:test runs this module without Vite, so
// the `~` alias is not available here.
import type {CatalogFunding, CatalogProduct} from './catalog.ts';

/** 0-100, integer, clamped: the meter width a progress bar can use directly. */
export function fundingPct(funding: CatalogFunding | null | undefined): number {
  if (!funding) return 0;
  return Math.min(100, Math.max(0, Math.round(funding.pct)));
}

/** "312 of 500 funded", the count a funded pre-order card shows under its meter. */
export function fundingLabel(funding: CatalogFunding | null | undefined): string {
  if (!funding) return '';
  return `${funding.unitsFunded} of ${funding.targetUnits} funded`;
}

/** Short status word for the funding state, or '' for draft/cancelled. */
export function fundingStatusText(
  funding: CatalogFunding | null | undefined,
): string {
  if (!funding) return '';
  switch (funding.state) {
    case 'open':
      return 'Funding open';
    case 'funded':
      return 'Funded';
    case 'missed':
      return 'Funding missed';
    default:
      return '';
  }
}

/** Whether a catalog product is a funded pre-order at all. */
export function isFundedPreorder(
  product: CatalogProduct | null | undefined,
): boolean {
  return Boolean(product?.funding);
}

/**
 * How precisely the meter reports progress. `exact` shows the rounded
 * percentage the catalog carries; `nearest-5` snaps it to 5% steps, which
 * reports the campaign without publishing an exact live order count.
 * One switch, so the reporting precision is a decision, not a rewrite.
 */
export type FundingPrecision = 'exact' | 'nearest-5';

/** The precision every caller gets unless it asks for another one. */
export const FUNDING_PRECISION_DEFAULT: FundingPrecision = 'exact';

/** The percentage actually displayed (bar width and `aria-valuenow`). */
export function fundingDisplayPct(
  funding: CatalogFunding | null | undefined,
  precision: FundingPrecision = FUNDING_PRECISION_DEFAULT,
): number {
  const pct = fundingPct(funding);
  return precision === 'nearest-5' ? Math.round(pct / 5) * 5 : pct;
}

/**
 * "Funding deadline 2026-12-01", or '' when the campaign carries no
 * deadline or an unparseable one. ISO day, the same readout format the
 * release rows use; no state wording, so it reads correctly after the
 * deadline as well as before it.
 */
export function fundingDeadlineText(
  funding: CatalogFunding | null | undefined,
): string {
  const raw = funding?.dateDeadline;
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return `Funding deadline ${parsed.toISOString().slice(0, 10)}`;
}

/** The refund promise carried next to every funded pre-order meter. */
export const FUNDING_REFUND_GUARANTEE =
  'If this product misses its funding target, your preorder is refunded in full.';

/** In-app explainer for how funded pre-orders work. */
export const FUNDING_EXPLAINER_PATH = '/preorder';

/** Link text for `FUNDING_EXPLAINER_PATH`. */
export const FUNDING_EXPLAINER_LABEL = 'How funded pre-orders work';
