import {useCallback, useMemo, useRef, useState} from 'react';
import type {Domain} from '~/lib/testing/scale';
import {fmtValue, unitLabel} from '~/lib/testing/scale';
import type {Theme} from '~/lib/testing/palette';
import type {Fig} from '~/lib/testing/types';
import {Chart, type ChartApi, type RangeState, type ReadoutState} from './Chart';
import {defaultHidden} from '~/lib/testing/labels';
import {Legend} from './Legend';
import {Readout} from './Readout';
import {UnitLine} from './UnitLine';

/**
 * Canvas chart with its cursor readout inside the plot and one row under it:
 * the legend on the left, the zoom reset on the right. Loaded after hydration,
 * with uPlot, by Figure.
 */
export default function ChartPanel({
  fig,
  theme,
  height,
  initialRange,
  onRange,
  hint = false,
}: {
  fig: Fig;
  theme: Theme;
  height: number;
  initialRange?: Domain | null;
  onRange?: (r: RangeState) => void;
  /** Show how to read values inside the plot until the first touch of it. */
  hint?: boolean;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => defaultHidden(fig));
  const [readout, setReadout] = useState<ReadoutState>(null);
  const [touched, setTouched] = useState(false);
  const [range, setRange] = useState<RangeState | null>(null);
  const [said, setSaid] = useState('');
  const api = useRef<ChartApi | null>(null);

  const handleRange = useCallback(
    (r: RangeState) => {
      setRange(r);
      onRange?.(r);
    },
    [onRange],
  );
  const handleReadout = useCallback(
    (r: ReadoutState) => {
      if (r) setTouched(true);
      setReadout(r);
    },
    [],
  );
  const onReady = useCallback((a: ChartApi | null) => {
    api.current = a;
  }, []);
  const legend = useMemo(
    () => <Legend fig={fig} theme={theme} hidden={hidden} onChange={setHidden} />,
    [fig, theme, hidden],
  );

  return (
    <div className="tr-panel">
      <UnitLine fig={fig} theme={theme} />
      <div className="tw-plotwrap" data-y2={fig.axes.y2 ? '1' : undefined}>
        <Readout fig={fig} readout={readout} />
        {hint && !touched ? (
          <p className="tw-hint" aria-hidden="true">
            <span className="tw-hint-fine">Hover for values, drag to zoom, arrow keys step through points.</span>
            <span className="tw-hint-coarse">Touch for values, pinch to zoom.</span>
          </p>
        ) : null}
        <Chart
          fig={fig}
          theme={theme}
          hidden={hidden}
          height={height}
          initialRange={initialRange}
          onReadout={handleReadout}
          onRange={handleRange}
          onReady={onReady}
          onAnnounce={setSaid}
        />
      </div>
      <p className="tw-sr" role="status" aria-live="polite">
        {said}
      </p>
      <div className="tr-keyrow">
        {legend}
        <p className="tr-actions">
          {range?.zoomed ? (
            <>
              <span>
                {fmtValue(range.x0)} to {fmtValue(range.x1)} {unitLabel(fig.axes.x.unit)}
              </span>
              <button type="button" className="tr-link" onClick={() => api.current?.reset()}>
                Reset zoom
              </button>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
