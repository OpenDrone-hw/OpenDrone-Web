import {fmtValue} from '~/lib/testing/scale';
import type {Fig} from '~/lib/testing/types';
import type {ReadoutState} from './Chart';

/**
 * Cursor values, drawn inside the plot at its top left. It has no box of its
 * own while the cursor is away, so it takes no row and never moves the plot.
 */
export function Readout({fig, readout}: {fig: Fig; readout: ReadoutState}) {
  if (!readout) return null;
  const xu = fig.axes.x.unit;
  const rows = readout.rows.filter((r) => r.kind !== 'frames');
  return (
    <div className="tw-readout" aria-hidden="true">
      <span className="tw-readout-x">
        {fmtValue(readout.x)} {xu}
      </span>
      {rows.map((r) => (
        <span key={r.id} className="tw-readout-row">
          <i style={{background: r.color}} />
          {r.label} <b>{fmtValue(r.y)}</b> {r.unit}
        </span>
      ))}
    </div>
  );
}
