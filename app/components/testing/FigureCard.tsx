import {useCallback, useEffect, useRef, useState, type ComponentType} from 'react';
import {figureCsv} from '~/lib/testing/export';
import {fmtValue, unitLabel} from '~/lib/testing/scale';
import type {Domain} from '~/lib/testing/scale';
import type {Fig, FigSummary, LogEntry, RunInfo} from '~/lib/testing/types';
import {Disclosure} from './Disclosure';
import {sentences} from './LogRow';
import {UnitLine} from './UnitLine';
import {StaticFigure} from './StaticFigure';
import {useWorkspaceTheme} from './WorkspaceShell';

type PanelProps = React.ComponentProps<typeof import('./ChartPanel').default>;

/**
 * Plot height from the width it is drawn at: wide on a desktop card, squarer on
 * a phone, so axis text stays the same size next to the data at every width.
 */
export function plotHeight(width: number, size: 'wide' | 'half'): number {
  if (width < 520) return Math.round(Math.min(400, Math.max(280, width * 1.0)));
  if (size === 'wide') return Math.round(Math.min(560, Math.max(380, width * 0.5)));
  return Math.round(Math.min(440, Math.max(320, width * 0.62)));
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

export function FigureCard({
  id,
  summary,
  run,
  preview,
  size,
  showRun,
  log,
  hint = false,
}: {
  id: string;
  summary: FigSummary;
  run: RunInfo | undefined;
  /** Thinned figure for the server-rendered SVG. */
  preview: Fig;
  size: 'wide' | 'half';
  /** The product has more than one run, so the card names its own. */
  showRun: boolean;
  /** The log entry that explains this figure, linked from the head. */
  log?: LogEntry;
  /** The first plot of the page says how to read values, inside the plot, until it is touched. */
  hint?: boolean;
}) {
  const theme = useWorkspaceTheme();
  const root = useRef<HTMLElement>(null);
  const [full, setFull] = useState<Fig | null>(null);
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plotEl = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(size === 'wide' ? 440 : 380);
  const [wide, setWide] = useState(false);
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
    const update = () => setHeight(plotHeight(el.clientWidth, size));
    update();
    if (!('ResizeObserver' in window)) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);

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

  useEffect(() => {
    if (!wide) return;
    const r = document.documentElement;
    r.style.overflow = 'hidden';
    const lock = async () => {
      if (!window.matchMedia('(pointer: coarse)').matches) return;
      try {
        await document.documentElement.requestFullscreen?.();
        await (screen.orientation as unknown as {lock?: (o: string) => Promise<void>}).lock?.('landscape');
      } catch {
        /* the overlay still fills the viewport */
      }
    };
    void lock();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setWide(false);
    window.addEventListener('keydown', onKey);
    return () => {
      r.style.overflow = '';
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    };
  }, [wide]);

  const fig = full ?? preview;
  const startRange = typeof window === 'undefined' ? null : readUrlRange(id);
  const caption = fig.fit
    ? `Quadratic fit: ${fmtValue(fig.fit.k)} ${fig.fit.unit} from ${fig.fit.fromThrottle} percent throttle up, ${fig.fit.n} holds, largest miss ${fig.fit.maxMiss} ${unitLabel(fig.axes.y.unit)}.`
    : null;

  return (
    <article className="tw-card" id={id} ref={root} data-size={size} data-ready={full && Panel ? '1' : '0'}>
      <header className="tw-card-head">
        <h3>{summary.title}</h3>
        {showRun ? (
          <p className="tw-meta">
            {summary.runId.replace(/-\d{4}-\d{2}-\d{2}$/, '')} <span aria-hidden="true">/</span> {run?.date ?? ''}
          </p>
        ) : null}
        <p className="tw-finding">{summary.finding}</p>
        {log ? (
          <p className="tw-logref">
            {log.changed ? <span>Changed: {sentences(log.changed, 1)} </span> : null}
            <a href={`#log-${log.id}`}>Log, {log.date}</a>
          </p>
        ) : null}
      </header>

      <div className="tw-plot" ref={plotEl} style={{minHeight: height + 64}}>
        {full && Panel ? (
          <>
            <Panel
              fig={full}
              theme={theme}
              height={height}
              initialRange={startRange}
              onRange={(r) => writeUrlRange(id, r)}
              onExpand={() => setWide(true)}
              onDownload={() => void download()}
              onCsv={csv}
              hint={hint}
            />
            {wide ? (
              <div className="tw-wide" role="dialog" aria-label={`${summary.title}, wide view`}>
                <button type="button" className="tw-close" onClick={() => setWide(false)} aria-label="Close wide view">
                  <span aria-hidden="true">x</span>
                </button>
                <h3 className="tw-wide-title">{summary.title}</h3>
                <Panel fig={full} theme={theme} height={Math.max(240, window.innerHeight - 150)} />
              </div>
            ) : null}
          </>
        ) : error ? (
          <p className="tw-error" role="alert">
            Figure {id} did not load ({error}).{' '}
            <button type="button" className="tw-linkbtn" onClick={load}>
              Retry
            </button>
          </p>
        ) : (
          <>
            <UnitLine fig={fig} theme={theme} />
            <StaticFigure
              fig={fig}
              width={size === 'wide' ? 1200 : 720}
              height={size === 'wide' ? 480 : 380}
              className="tw-static"
              titles={false}
            />
          </>
        )}
      </div>
      {caption ? <p className="tw-caption">{caption}</p> : null}

      <Disclosure figs={[fig]} />
    </article>
  );
}
