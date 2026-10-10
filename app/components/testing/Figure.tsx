import {useCallback, useEffect, useRef, useState, type ComponentType} from 'react';
import {figureCsv, tableRows} from '~/lib/testing/export';
import {fmtValue, unitLabel} from '~/lib/testing/scale';
import type {Domain} from '~/lib/testing/scale';
import {caveatFlagged, caveatText, type Fig, type FigSummary, type RunInfo} from '~/lib/testing/types';
import {UnitLine} from './UnitLine';
import {StaticFigure} from './StaticFigure';
import {useWorkspaceTheme} from './WorkspaceShell';

type PanelProps = React.ComponentProps<typeof import('./ChartPanel').default>;

/**
 * Plot height from the width it is drawn at: at most 0.56 of the column, as in
 * the exported reports, and squarer on a phone so axis text stays the same size
 * next to the data at every width.
 */
export function plotHeight(width: number): number {
  if (width < 520) return Math.round(Math.min(380, Math.max(260, width * 0.9)));
  return Math.round(Math.min(460, Math.max(300, width * 0.52)));
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
  hint = false,
}: {
  id: string;
  /** Figure number in the document; the findings under it are numbered from it. */
  no: number;
  summary: FigSummary;
  run: RunInfo | undefined;
  /** Thinned figure for the server-rendered SVG. */
  preview: Fig;
  /** The first plot of the page says how to read values, inside the plot, until it is touched. */
  hint?: boolean;
}) {
  const theme = useWorkspaceTheme();
  const root = useRef<HTMLElement>(null);
  const [full, setFull] = useState<Fig | null>(null);
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plotEl = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(420);
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
    const update = () => setHeight(plotHeight(el.clientWidth));
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
  const fit = fig.fit
    ? `Dashed line: quadratic fit, ${fmtValue(fig.fit.k)} ${fig.fit.unit} from ${fig.fit.fromThrottle} percent throttle up, ${fig.fit.n} holds, largest miss ${fig.fit.maxMiss} ${unitLabel(fig.axes.y.unit)}.`
    : null;
  // Notes before the measurement, as in the exported report; a flagged note comes first.
  const notes = [...fig.caveats].sort((a, b) => Number(caveatFlagged(b)) - Number(caveatFlagged(a))).map(caveatText);
  const items = [...notes, summary.finding];
  const rows = tableRows(fig);

  return (
    <figure className="tr-fig" id={id} ref={root} data-ready={full && Panel ? '1' : '0'} aria-labelledby={`${id}-cap`}>
      <div className="tr-plot" ref={plotEl} style={{minHeight: height + 70}}>
        {full && Panel ? (
          <Panel
            fig={full}
            theme={theme}
            height={height}
            initialRange={startRange}
            onRange={(r) => writeUrlRange(id, r)}
            onDownload={() => void download()}
            onCsv={csv}
            hint={hint}
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
            <StaticFigure fig={fig} width={820} height={height} className="tr-static" titles={false} />
          </>
        )}
      </div>
      <p className="tr-prov">
        Setup: {summary.chip}. Source: <code>{summary.runId.replace(/-\d{4}-\d{2}-\d{2}$/, '')}</code> {run?.date ?? ''}
        {fig.cite ? (
          <>
            , <code>{fig.cite.replace(/#L\d+-L\d+/g, '').split('; ').join(', ')}</code>
          </>
        ) : null}
        .
      </p>
      <figcaption id={`${id}-cap`}>
        <b>Figure {no}.</b> {summary.title}.{fit ? ` ${fit}` : ''}
      </figcaption>
      <p className="tr-view">
        View <code>{id}</code> <b>Findings</b>
      </p>
      <ul className="tr-findings">
        {items.map((t, i) => (
          <li key={i} id={`fig-${no}-${i + 1}`}>
            <a className="tr-n" href={`#fig-${no}-${i + 1}`}>
              {no}.{i + 1}
            </a>{' '}
            {t}
          </li>
        ))}
      </ul>
      <details className="tr-values">
        <summary>{rows ? `Reduction and values of Figure ${no}` : `Reduction of Figure ${no}`}</summary>
        {fig.reduction ? <p>{fig.reduction}</p> : null}
        {rows ? (
          <table>
            <thead>
              <tr>
                <th scope="col">Series</th>
                <th scope="col">
                  {fig.axes.x.label} ({unitLabel(fig.axes.x.unit)})
                </th>
                <th scope="col">
                  {fig.axes.y.label} ({unitLabel(fig.axes.y.unit)})
                </th>
                <th scope="col">25th to 75th</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.series.replace(/, hold median.*$/, '')}</td>
                  <td>{r.x}</td>
                  <td>{r.y}</td>
                  <td>{r.band}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </details>
    </figure>
  );
}
