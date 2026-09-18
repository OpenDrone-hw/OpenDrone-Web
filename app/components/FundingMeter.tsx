import {Link} from 'react-router';
import type {CatalogFunding} from '~/lib/catalog';
import {
  FUNDING_EXPLAINER_LABEL,
  FUNDING_EXPLAINER_PATH,
  FUNDING_PRECISION_DEFAULT,
  FUNDING_REFUND_GUARANTEE,
  fundingDeadlineText,
  fundingDisplayPct,
  fundingLabel,
  fundingStatusText,
  type FundingPrecision,
} from '~/lib/funding';

/**
 * A funded pre-order's progress toward its unit target: a bar, the unit
 * count under it, the campaign state, the deadline and the refund promise.
 *
 * Funding is NOT availability. Whether the buy button works is Odoo's
 * availability word (`app/lib/catalog.ts`); this component only reports how
 * far the campaign has come, so it never gates or disables anything.
 *
 * Renders nothing when the product carries no `funding` object, which is
 * every ordinary product — the caller can mount it unconditionally.
 *
 * `compact` is the card variant: bar plus label only. It carries no link,
 * because a product card is already one anchor and nesting anchors is
 * invalid HTML.
 */
export function FundingMeter({
  funding,
  compact,
  precision = FUNDING_PRECISION_DEFAULT,
  className,
}: {
  funding: CatalogFunding | null | undefined;
  /** Card variant: the bar and its unit count, no prose and no link. */
  compact?: boolean;
  /** Reported precision: exact percentage, or snapped to 5% steps. */
  precision?: FundingPrecision;
  className?: string;
}) {
  if (!funding) return null;

  const pct = fundingDisplayPct(funding, precision);
  const label = fundingLabel(funding);
  const status = fundingStatusText(funding);
  const deadline = fundingDeadlineText(funding);

  return (
    <div
      className={`funding-meter${compact ? ' is-compact' : ''}${
        className ? ` ${className}` : ''
      }`}
      data-funding-state={funding.state}
    >
      <span
        className="funding-meter-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={label}
      >
        <span className="funding-meter-fill" style={{width: `${pct}%`}} />
      </span>
      <span className="funding-meter-label">{label}</span>
      {compact ? null : (
        <>
          {status ? (
            <span className="funding-meter-status">{status}</span>
          ) : null}
          {deadline ? (
            <span className="funding-meter-deadline">{deadline}</span>
          ) : null}
          <p className="funding-meter-refund">{FUNDING_REFUND_GUARANTEE}</p>
          <Link className="funding-meter-link" to={FUNDING_EXPLAINER_PATH}>
            {FUNDING_EXPLAINER_LABEL}
          </Link>
        </>
      )}
    </div>
  );
}
