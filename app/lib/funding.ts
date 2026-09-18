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

/**
 * 0-100, integer, clamped: the meter width a progress bar can use directly.
 *
 * Derived from `unitsFunded / targetUnits`, never from the catalog's own
 * `pct` field: the label below the bar reads `unitsFunded` of
 * `targetUnits` too (`fundingLabel`), and computing both from the same two
 * numbers is the only way the bar's `aria-valuenow` can never contradict
 * the label it sits next to. `pct` still rides on `CatalogFunding` for
 * contract compatibility (`catalog.ts` parses it) but nothing reads it for
 * display any more.
 *
 * A result that is not a finite number, or a non-positive target, reads 0,
 * not `NaN`: `NaN` would reach the DOM as `width: NaN%` and
 * `aria-valuenow="NaN"`, which is outside the range the `progressbar` role
 * allows.
 */
export function fundingPct(funding: CatalogFunding | null | undefined): number {
  if (
    !funding ||
    !Number.isFinite(funding.unitsFunded) ||
    !Number.isFinite(funding.targetUnits) ||
    funding.targetUnits <= 0
  ) {
    return 0;
  }
  const pct = (funding.unitsFunded / funding.targetUnits) * 100;
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, Math.round(pct)));
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

/**
 * Whether a campaign may be shown to a buyer at all.
 *
 * `draft` is an unpublished campaign and `cancelled` is a withdrawn one.
 * Neither has a unit count, a deadline or a refund guarantee a buyer is
 * allowed to read, so every public surface renders nothing for them.
 */
export function isFundingPublic(
  funding: CatalogFunding | null | undefined,
): boolean {
  if (!funding) return false;
  return (
    funding.state === 'open' ||
    funding.state === 'funded' ||
    funding.state === 'missed'
  );
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
 *
 * The day is read off the string, never through `new Date`. A bare
 * datetime such as "2026-12-01 23:59:59" is parsed as a local instant, so
 * `new Date(...).toISOString()` names a different day on a UTC server than
 * in a visitor's browser: an off-by-one deadline and a React hydration
 * mismatch on the same line.
 */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/;

export function fundingDeadlineText(
  funding: CatalogFunding | null | undefined,
): string {
  const raw = funding?.dateDeadline;
  if (!raw) return '';
  const match = ISO_DAY.exec(raw.trim());
  if (!match) return '';
  const [, year, month, day] = match;
  // Reject a well-formed but impossible day, e.g. 2026-13-45 or 2026-02-30.
  const utc = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) {
    return '';
  }
  return `Funding deadline ${year}-${month}-${day}`;
}

/** The refund promise carried next to every funded pre-order meter. */
export const FUNDING_REFUND_GUARANTEE =
  'If this product misses its funding target, your preorder is refunded in full.';

/**
 * What the meter says instead once the campaign HAS missed. The conditional
 * promise above reads as if the outcome were still open, on a page that
 * states "Funding missed" one line higher. Present tense, not "has been
 * refunded": refunds are issued by hand after the miss (erp
 * `docs/runbooks/funding-missed.md`), so the page must not claim the money
 * is already back. Same wording as terms art. 7bis.8 and `/preorder`, and no
 * deadline the terms do not carry.
 */
export const FUNDING_MISSED_NOTICE =
  'This product missed its funding target. Every preorder of it is refunded in full.';

/** The refund line for a campaign in its current state. */
export function fundingRefundText(
  funding: CatalogFunding | null | undefined,
): string {
  if (!funding) return '';
  return funding.state === 'missed'
    ? FUNDING_MISSED_NOTICE
    : FUNDING_REFUND_GUARANTEE;
}

/**
 * In-app explainer for how funded pre-orders work. The catalog used to
 * also carry `funding.explainer_url`; nothing read it, so it was removed
 * rather than kept in sync with a page this route already replaces.
 */
export const FUNDING_EXPLAINER_PATH = '/preorder';

/** Link text for `FUNDING_EXPLAINER_PATH`. */
export const FUNDING_EXPLAINER_LABEL = 'How funded pre-orders work';
