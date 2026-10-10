import {useCallback, useRef, useState} from 'react';
import type {Domain} from '~/lib/testing/scale';
import {fmtValue, unitLabel} from '~/lib/testing/scale';
import type {Theme} from '~/lib/testing/palette';
import type {Fig} from '~/lib/testing/types';
import {Chart, type ChartApi, type RangeState, type ReadoutState} from './Chart';
import {Legend} from './Legend';
import {Readout} from './Readout';

/**
 * Canvas chart with its cursor readout inside the plot, an inline legend, and
 * one row of actions. Loaded after hydration, with uPlot, by FigureCard.
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
  bare = false,
  syncKey,
  showXLabels = true,
  hiddenExt,
}: {
  fig: Fig;
  theme: Theme;
  height: number;
  initialRange?: Domain | null;
  onRange?: (r: RangeState) => void;
  onExpand?: () => void;
  onDownload?: () => void;
  onCsv?: () => void;
  /** A panel of a stack: no legend and no buttons, the stack draws them. */
  bare?: boolean;
  syncKey?: string;
  showXLabels?: boolean;
  /** Series hidden from outside (the stack's legend). */
  hiddenExt?: ReadonlySet<string>;
}) {
  const [hiddenOwn, setHidden] = useState<Set<string>>(() => new Set());
  const hidden = hiddenExt ?? hiddenOwn;
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
      {bare ? null : (
        <p className="tw-unitline" aria-hidden="true">
          {fig.axes.y.label}, {unitLabel(fig.axes.y.unit)}
          {fig.axes.y2 ? `. Right: ${fig.axes.y2.label}, ${unitLabel(fig.axes.y2.unit)}` : ''}
        </p>
      )}
      <div className="tw-plotwrap" data-y2={fig.axes.y2 ? '1' : undefined}>
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
          syncKey={syncKey}
          showXLabels={showXLabels}
        />
      </div>
      <p className="tw-sr" role="status" aria-live="polite">
        {said}
      </p>
      {bare ? null : (
        <div className="tw-keyrow">
          <Legend fig={fig} theme={theme} hidden={hidden} onChange={setHidden} />
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
            {onExpand || onDownload || onCsv ? (
              <span className="tw-btns" role="group" aria-label="Figure actions">
                {onExpand ? (
                  <button type="button" className="tw-act" onClick={onExpand}>
                    Wide view
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
              </span>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
