import {useCallback, useEffect, useRef, useState, type ComponentType} from 'react';
import {figureCsv} from '~/lib/testing/export';
import {unitLabel} from '~/lib/testing/scale';
import type {Domain} from '~/lib/testing/scale';
import {legendCorner, markLines} from '~/lib/testing/geometry';
import {defaultHidden} from '~/lib/testing/labels';
import {caveatFlagged, caveatRunWide, caveatText, type Fig, type FigSummary, type RunInfo} from '~/lib/testing/types';
import {keyStyle, sourceLine} from '~/lib/testing/layout';
import {Legend} from './Legend';
import {UnitLine} from './UnitLine';
import {StaticFigure} from './StaticFigure';
import {useWorkspaceTheme} from './WorkspaceShell';

const noop = () => {};

type PanelProps = React.ComponentProps<typeof import('./ChartPanel').default>;

/**
 * Plot height from the width it is drawn at: at most 0.42 of the column, and squarer on a phone so axis text stays the same size
 * next to the data at every width.
 */
export function plotHeight(width: number): number {
  if (width < 520) return Math.round(Math.min(340, Math.max(240, width * 0.8)));
  return Math.round(Math.min(380, Math.max(260, width * 0.42)));
}

/** `?f=<id>&x0=&x1=` for this figure, or null. */
function readUrlRange(id: string): Domain | null {
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.get('f') !== id) return null;
    const a = Number(q.get('x0'));
    const b = Number(q.get('x1'));
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
  } catch {
    return null;
  }
}

function writeUrlRange(id: string, r: {x0: number; x1: number; zoomed: boolean}) {
  try {
    const url = new URL(window.location.href);
    if (r.zoomed) {
      url.searchParams.set('f', id);
      url.searchParams.set('x0', String(Number(r.x0.toPrecision(6))));
      url.searchParams.set('x1', String(Number(r.x1.toPrecision(6))));
    } else if (url.searchParams.get('f') === id) {
      url.searchParams.delete('f');
      url.searchParams.delete('x0');
      url.searchParams.delete('x1');
    } else {
      return;
    }
    window.history.replaceState(window.history.state, '', url);
  } catch {
    /* history can be unavailable in sandboxed frames */
  }
}

export function Figure({
  id,
  no,
  summary,
  run,
  preview,
}: {
  id: string;
  /** Figure number in the document; the findings under it are numbered from it. */
  no: number;
  summary: FigSummary;
  run: RunInfo | undefined;
  /** Thinned figure for the server-rendered SVG. */
  preview: Fig;
}) {
  const theme = useWorkspaceTheme();
  const root = useRef<HTMLElement>(null);
  const [full, setFull] = useState<Fig | null>(null);
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plotEl = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(420);
  const [width, setWidth] = useState(920);
  const started = useRef(false);

  const load = useCallback(() => {
    if (started.current) return;
    started.current = true;
    Promise.all([
      fetch(`/testing/fig/${id}.json`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<Fig>;
      }),
      import('./ChartPanel'),
    ])
      .then(([fig, mod]) => {
        setFull(fig);
        setPanel(() => mod.default);
      })
      .catch((e: unknown) => {
        started.current = false;
        setError(e instanceof Error ? e.message : 'failed');
      });
  }, [id]);

  useEffect(() => {
    const el = plotEl.current;
    if (!el) return;
    const update = () => {
      setHeight(plotHeight(el.clientWidth));
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    update();
    if (!('ResizeObserver' in window)) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) {
      load();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          load();
          io.disconnect();
        }
      },
      {rootMargin: '600px 0px'},
    );
    io.observe(el);
    return () => io.disconnect();
  }, [load]);

  // A shared link with ?f=<id> opens on this figure.
  useEffect(() => {
    if (readUrlRange(id)) {
      root.current?.scrollIntoView({block: 'start'});
      load();
    }
  }, [id, load]);

  const download = useCallback(async () => {
    if (!full) return;
    const [{renderToStaticMarkup}, {createElement}] = await Promise.all([
      import('react-dom/server'),
      import('react'),
    ]);
    const svg = renderToStaticMarkup(
      createElement(StaticFigure, {fig: full, width: 1200, height: 675, theme}),
    );
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], {type: 'image/svg+xml'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${id}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, [full, id, theme]);

  const csv = useCallback(() => {
    if (!full) return;
    const blob = new Blob([figureCsv(full, run)], {type: 'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${id}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, [full, id, run]);

  const fig = full ?? preview;
  const startRange = typeof window === 'undefined' ? null : readUrlRange(id);
  // The measurement first, then the notes of this figure, a flagged one before the rest. A note about
  // the whole run is stated once under the run's setup, not under each figure.
  const notes = fig.caveats
    .filter((c) => !caveatRunWide(c))
    .sort((a, b) => Number(caveatFlagged(b)) - Number(caveatFlagged(a)))
    .map(caveatText);
  const items = [
    summary.finding,
    ...(fig.fit
      ? [`Quadratic fit through the origin over ${fig.fit.n} holds from ${fig.fit.fromThrottle} percent throttle: ${fig.fit.k} ${fig.fit.unit}, largest miss ${fig.fit.maxMiss} ${unitLabel(fig.axes.y.unit)}.`]
      : []),
    ...notes,
  ];
  const marks = markLines(fig);
  const corner = legendCorner(preview, defaultHidden(preview));
  const caption = `${summary.title}.${fig.fit ? ' Dashed line: quadratic fit.' : ''}${marks.map((m) => ` Mark ${m.no}: ${m.text}.`).join('')}`;

  return (
    <figure className="tr-fig" id={id} ref={root} data-ready={full && Panel ? '1' : '0'} aria-labelledby={`${id}-cap`}>
      <div className="tr-plot" ref={plotEl} style={{minHeight: height + 4}}>
        {full && Panel ? (
          <Panel
            fig={full}
            theme={theme}
            height={height}
            initialRange={startRange}
            onRange={(r) => writeUrlRange(id, r)}
            corner={corner}
          />
        ) : error ? (
          <p className="tr-error" role="alert">
            Figure {no} did not load ({error}).{' '}
            <button type="button" className="tr-link" onClick={load}>
              Retry
            </button>
          </p>
        ) : (
          <>
            <UnitLine fig={fig} theme={theme} />
            <StaticFigure fig={fig} width={width} height={height} className="tr-static" titles={false} side={width >= 520} />
            <div className="tr-keyrow" data-corner={corner ?? undefined} style={keyStyle(fig)}>
              <Legend fig={fig} theme={theme} hidden={defaultHidden(fig)} onChange={noop} />
            </div>
          </>
        )}
      </div>
      <figcaption id={`${id}-cap`}>
        <b>Figure {no}.</b> {caption}{' '}
        <span className="tr-src" data-view={id}>
          Source {sourceLine(summary.runId, run?.date, fig.cite)}.{' '}
          <button type="button" className="tr-link" disabled={!full} onClick={() => void download()} title={`${id}.svg`}>
            SVG
          </button>{' '}
          <button type="button" className="tr-link" disabled={!full} onClick={csv} title={`${id}.csv`}>
            CSV
          </button>
        </span>
      </figcaption>
      {items.map((t, i) => (
        <p key={i} className="tr-find">
          {t}
        </p>
      ))}
    </figure>
  );
}
