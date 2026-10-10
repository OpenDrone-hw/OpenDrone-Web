import {useCallback, useEffect, useRef, useState, type ComponentType} from 'react';
import {domainColorCss} from '~/lib/testing/palette';
import type {Domain} from '~/lib/testing/scale';
import type {Fig, FigSummary, RunInfo} from '~/lib/testing/types';
import {Disclosure} from './Disclosure';
import {StaticFigure} from './StaticFigure';
import {useWorkspaceTheme} from './WorkspaceShell';

type PanelProps = React.ComponentProps<typeof import('./ChartPanel').default>;

function plotHeight(size: 'wide' | 'half'): number {
  if (typeof window === 'undefined') return size === 'wide' ? 460 : 380;
  const w = window.innerWidth;
  if (w < 640) return 300;
  return size === 'wide' ? (w < 1100 ? 400 : 480) : 380;
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
}: {
  id: string;
  summary: FigSummary;
  run: RunInfo | undefined;
  /** Thinned figure for the server-rendered SVG. */
  preview: Fig;
  size: 'wide' | 'half';
}) {
  const theme = useWorkspaceTheme();
  const root = useRef<HTMLElement>(null);
  const [full, setFull] = useState<Fig | null>(null);
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(size === 'wide' ? 460 : 380);
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
    setHeight(plotHeight(size));
    const onResize = () => setHeight(plotHeight(size));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
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

  useEffect(() => {
    if (!wide) return;
    const r = document.documentElement;
    r.style.overflow = 'hidden';
    const lock = async () => {
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

  const setup = run?.setup ?? [];
  const date = run?.date ?? '';
  const fig = full ?? preview;
  const startRange = typeof window === 'undefined' ? null : readUrlRange(id);

  return (
    <article className="tw-card" id={id} ref={root} data-size={size} data-ready={full && Panel ? '1' : '0'}>
      <header className="tw-card-head">
        <h3>{summary.title}</h3>
        <ul className="tw-chips" aria-label="Run">
          <li className="tw-chip tw-chip-mono">{summary.runId}</li>
          <li className="tw-chip tw-chip-mono">{date}</li>
          <li className="tw-chip tw-chip-mono tw-chip-domain" style={{['--dot' as string]: domainColorCss(summary.domain)}}>
            {summary.domain}
          </li>
          <li className="tw-chip tw-chip-mono">
            {summary.caveats} caveats{summary.flagged ? ' !' : ''}
          </li>
        </ul>
        <p className="tw-setup-chip">{summary.chip}</p>
        <p className="tw-finding">{summary.finding}</p>
      </header>

      <div className="tw-plot" style={{minHeight: height + 120}}>
        {full && Panel ? (
          <>
            <Panel
              fig={full}
              theme={theme}
              height={height}
              initialRange={startRange}
              onRange={(r) => writeUrlRange(id, r)}
              extra={
                <div className="tw-tools">
                  <button type="button" className="tw-btn" onClick={() => void download()}>
                    Download SVG
                  </button>
                  <button type="button" className="tw-btn tw-wide-btn" onClick={() => setWide(true)}>
                    Open wide view
                  </button>
                </div>
              }
            />
            {wide ? (
              <div className="tw-wide" role="dialog" aria-label={`${summary.title}, wide view`}>
                <div className="tw-wide-bar">
                  <strong>{summary.title}</strong>
                  <button type="button" className="tw-btn" onClick={() => setWide(false)}>
                    Close
                  </button>
                </div>
                <Panel fig={full} theme={theme} height={Math.max(220, window.innerHeight - 190)} />
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
          <StaticFigure fig={fig} width={size === 'wide' ? 1200 : 720} height={size === 'wide' ? 480 : 380} className="tw-static" />
        )}
      </div>

      <Disclosure caveats={fig.caveats} setup={setup} reduction={fig.reduction} cite={fig.cite} />
    </article>
  );
}
