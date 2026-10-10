import {fmtValue} from '~/lib/testing/scale';
import type {Fig} from '~/lib/testing/types';
import type {RangeState, ReadoutState} from './Chart';

/**
 * A fixed strip above the plot: hover values on the left, zoom range and the
 * Reset button on the right. It sits outside the plot, so it never covers data.
 */
export function Readout({
  fig,
  readout,
  range,
  zoomUsed,
  onReset,
}: {
  fig: Fig;
  readout: ReadoutState;
  range: RangeState | null;
  zoomUsed: boolean;
  onReset: () => void;
}) {
  const xu = fig.axes.x.unit;
  return (
    <div className="tw-readout">
      <div className="tw-readout-vals" aria-live="off">
        {readout ? (
          <>
            <span className="tw-readout-x">
              {fmtValue(readout.x)} {xu}
            </span>
            {readout.rows.map((r) => (
              <span key={r.id} className="tw-readout-row">
                <i style={{background: r.color}} aria-hidden="true" />
                {r.label} <b>{fmtValue(r.y)}</b> {r.unit}
                <em>
                  {' '}
                  at {fmtValue(r.x)}
                </em>
              </span>
            ))}
          </>
        ) : (
          <span className="tw-readout-hint">{zoomUsed ? 'Hover for values' : 'Hover for values, drag to zoom'}</span>
        )}
      </div>
      <div className="tw-readout-zoom">
        {range?.zoomed ? (
          <>
            <span className="tw-range">
              {fmtValue(range.x0)} to {fmtValue(range.x1)} {xu}
            </span>
            <button type="button" className="tw-btn" onClick={onReset}>
              Reset
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
