import {fmtValue, unitLabel} from '~/lib/testing/scale';
import type {Fig} from '~/lib/testing/types';
import type {ReadoutState} from './Chart';

/**
 * Cursor values in a boxed readout pinned to the top of the plot, on the side
 * away from the cursor. It is absent while the cursor is away, so it takes no
 * row and never moves the plot.
 */
export function Readout({fig, readout}: {fig: Fig; readout: ReadoutState}) {
  if (!readout) return null;
  const xu = fig.axes.x.unit;
  const rows = readout.rows.filter((r) => r.kind !== 'frames');
  return (
    <div className="tw-readout" data-side={readout.frac < 0.45 ? 'right' : 'left'} aria-hidden="true">
      <span className="tw-readout-x">
        {fmtValue(readout.x)} {unitLabel(xu)}
      </span>
      {rows.map((r) => (
        <span key={r.id} className="tw-readout-row">
          <i style={{background: r.color}} />
          {r.label} <b>{fmtValue(r.y)}</b> {unitLabel(r.unit)}
        </span>
      ))}
    </div>
  );
}
