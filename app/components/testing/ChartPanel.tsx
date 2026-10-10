import {useCallback, useRef, useState} from 'react';
import type {Domain} from '~/lib/testing/scale';
import {fmtValue} from '~/lib/testing/scale';
import type {Theme} from '~/lib/testing/palette';
import type {Fig} from '~/lib/testing/types';
import {Chart, type ChartApi, type RangeState, type ReadoutState} from './Chart';
import {Legend} from './Legend';
import {Readout} from './Readout';

/**
 * Canvas chart with its cursor readout inside the plot, an inline legend, and
 * one row of text actions. Loaded after hydration, with uPlot, by FigureCard.
 * Also used by the wide view.
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
}: {
  fig: Fig;
  theme: Theme;
  height: number;
  initialRange?: Domain | null;
  onRange?: (r: RangeState) => void;
  onExpand?: () => void;
  onDownload?: () => void;
  onCsv?: () => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [readout, setReadout] = useState<ReadoutState>(null);
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
  const onReady = useCallback((a: ChartApi | null) => {
    api.current = a;
  }, []);

  return (
    <div className="tw-panel">
      <div className="tw-plotwrap">
        <Readout fig={fig} readout={readout} />
        <Chart
          fig={fig}
          theme={theme}
          hidden={hidden}
          height={height}
          initialRange={initialRange}
          onReadout={setReadout}
          onRange={handleRange}
          onReady={onReady}
          onAnnounce={setSaid}
        />
      </div>
      <p className="tw-sr" role="status" aria-live="polite">
        {said}
      </p>
      <div className="tw-keyrow">
        <Legend fig={fig} theme={theme} hidden={hidden} onChange={setHidden} />
        <div className="tw-actions">
          {range?.zoomed ? (
            <>
              <span className="tw-range">
                {fmtValue(range.x0)} to {fmtValue(range.x1)} {fig.axes.x.unit}
              </span>
              <button type="button" className="tw-act" onClick={() => api.current?.reset()}>
                Reset zoom
              </button>
            </>
          ) : null}
          {onExpand ? (
            <button type="button" className="tw-act" onClick={onExpand}>
              Expand
            </button>
          ) : null}
          {onDownload ? (
            <button type="button" className="tw-act" onClick={onDownload}>
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
      <p className="tw-hint">
        <span className="tw-hint-fine">Hover for values, drag to zoom, arrow keys step through points.</span>
        <span className="tw-hint-coarse">Touch for values, pinch to zoom.</span>
      </p>
    </div>
  );
}
