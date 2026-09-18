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
