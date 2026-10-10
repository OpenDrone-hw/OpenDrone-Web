import {useCallback, useRef, useState, type ReactNode} from 'react';
import type {Domain} from '~/lib/testing/scale';
import type {Theme} from '~/lib/testing/palette';
import type {Fig} from '~/lib/testing/types';
import {Chart, type ChartApi, type RangeState, type ReadoutState} from './Chart';
import {Legend} from './Legend';
import {Readout} from './Readout';

/**
 * Readout strip, canvas chart and legend for one figure. Loaded after
 * hydration, with uPlot, by FigureCard. Also used by the wide view.
 */
export default function ChartPanel({
  fig,
  theme,
  height,
  initialRange,
  onRange,
  extra,
}: {
  fig: Fig;
  theme: Theme;
  height: number;
  initialRange?: Domain | null;
  onRange?: (r: RangeState) => void;
  /** Buttons that sit at the end of the legend row. */
  extra?: ReactNode;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [readout, setReadout] = useState<ReadoutState>(null);
  const [range, setRange] = useState<RangeState | null>(null);
  const [zoomUsed, setZoomUsed] = useState(false);
  const api = useRef<ChartApi | null>(null);

  const handleRange = useCallback(
    (r: RangeState) => {
      setRange(r);
      if (r.zoomed) setZoomUsed(true);
      onRange?.(r);
    },
    [onRange],
  );
  const onReady = useCallback((a: ChartApi | null) => {
    api.current = a;
  }, []);

  return (
    <div className="tw-panel">
      <Readout fig={fig} readout={readout} range={range} zoomUsed={zoomUsed} onReset={() => api.current?.reset()} />
      <Chart
        fig={fig}
        theme={theme}
        hidden={hidden}
        height={height}
        initialRange={initialRange}
        onReadout={setReadout}
        onRange={handleRange}
        onReady={onReady}
      />
      <div className="tw-legend-row">
        <Legend fig={fig} theme={theme} hidden={hidden} onChange={setHidden} />
        {extra}
      </div>
    </div>
  );
}
