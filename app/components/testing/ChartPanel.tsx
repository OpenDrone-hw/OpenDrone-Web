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
 * Canvas chart with its cursor readout inside the plot and one toolbar row:
 * the legend on the left, the actions on the right. Loaded after hydration,
 * with uPlot, by FigureCard. Also used by the wide view and, bare, by the
 * stacked card.
 */
export default function ChartPanel({
  fig,
  theme,
  height,
  initialRange,
  onRange,
  onExpand,
  onDownload,
  onCsv,
  bare = false,
  syncKey,
  showXLabels = true,
  hiddenExt,
  onReadout,
  hint = false,
}: {
  fig: Fig;
  theme: Theme;
  height: number;
  initialRange?: Domain | null;
  onRange?: (r: RangeState) => void;
  onExpand?: () => void;
  onDownload?: () => void;
  onCsv?: () => void;
  /** A panel of a stack: no title line, legend or buttons, the stack draws them. */
  bare?: boolean;
  syncKey?: string;
  showXLabels?: boolean;
  /** Series hidden from outside (the stack's legend). */
  hiddenExt?: ReadonlySet<string>;
  /** The stack shows one shared readout; this panel then draws none of its own. */
  onReadout?: (r: ReadoutState) => void;
  /** Show how to read values inside the plot until the first touch of it. */
  hint?: boolean;
}) {
  const [hiddenOwn, setHidden] = useState<Set<string>>(() => defaultHidden(fig));
  const hidden = hiddenExt ?? hiddenOwn;
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
      if (onReadout) onReadout(r);
      else setReadout(r);
    },
    [onReadout],
  );
  const onReady = useCallback((a: ChartApi | null) => {
    api.current = a;
  }, []);
  const legend = useMemo(
    () => (bare ? null : <Legend fig={fig} theme={theme} hidden={hidden} onChange={setHidden} />),
    [bare, fig, theme, hidden],
  );

  return (
    <div className="tw-panel">
      {bare ? null : <UnitLine fig={fig} theme={theme} />}
      <div className="tw-plotwrap" data-y2={fig.axes.y2 ? '1' : undefined}>
        {onReadout ? null : <Readout fig={fig} readout={readout} />}
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
          syncKey={syncKey}
          showXLabels={showXLabels}
        />
      </div>
      <p className="tw-sr" role="status" aria-live="polite">
        {said}
      </p>
      {bare ? null : (
        <div className="tw-keyrow">
          {legend}
          <div className="tw-actions">
            {range?.zoomed ? (
              <>
                <span className="tw-range">
                  {fmtValue(range.x0)} to {fmtValue(range.x1)} {unitLabel(fig.axes.x.unit)}
                </span>
                <button type="button" className="tw-act" onClick={() => api.current?.reset()}>
                  Reset zoom
                </button>
              </>
            ) : null}
            {onExpand ? (
              <button type="button" className="tw-act" onClick={onExpand}>
                Wide view
              </button>
            ) : null}
            {onDownload ? (
              <button type="button" className="tw-act tw-act-svg" onClick={onDownload}>
                SVG
              </button>
            ) : null}
            {onCsv ? (
              <button type="button" className="tw-act" onClick={onCsv}>
                CSV
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
