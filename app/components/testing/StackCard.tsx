import {useCallback, useEffect, useMemo, useRef, useState, type ComponentType} from 'react';
import {figureCsv} from '~/lib/testing/export';
import {fmtValue, unitLabel} from '~/lib/testing/scale';
import {markerPath} from '~/lib/testing/geometry';
import {plainLabel} from '~/lib/testing/labels';
import {assignStyles} from '~/lib/testing/palette';
import type {Fig, FigSummary, RunInfo} from '~/lib/testing/types';
import {Disclosure} from './Disclosure';
import {Legend} from './Legend';
import type {ReadoutState} from './Chart';
import {StaticFigure} from './StaticFigure';
import {useWorkspaceTheme} from './WorkspaceShell';

type PanelProps = React.ComponentProps<typeof import('./ChartPanel').default>;

/**
 * Several figures that share a run and an x axis, drawn as one card: one panel
 * per quantity, stacked, on one shared axis and one shared cursor. A reader
 * sees at a glance that thrust, pack voltage and temperature move together at
 * the same throttle. Each panel keeps its own finding and its own anchor.
 */
export function StackCard({
  title,
  ids,
  summaries,
  run,
  previews,
  syncKey,
}: {
  title: string;
  ids: string[];
  summaries: Record<string, FigSummary>;
  run: RunInfo | undefined;
  previews: Record<string, Fig>;
  syncKey: string;
}) {
  const theme = useWorkspaceTheme();
  const root = useRef<HTMLElement>(null);
  const [full, setFull] = useState<Record<string, Fig> | null>(null);
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [reads, setReads] = useState<Record<string, ReadoutState>>({});
  const started = useRef(false);

  const load = useCallback(() => {
    if (started.current) return;
    started.current = true;
    Promise.all([
      Promise.all(
        ids.map((id) =>
          fetch(`/testing/fig/${id}.json`).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json() as Promise<Fig>;
          }),
        ),
      ),
      import('./ChartPanel'),
    ])
      .then(([figs, mod]) => {
        setFull(Object.fromEntries(figs.map((f) => [f.id, f])));
        setPanel(() => mod.default);
      })
      .catch((e: unknown) => {
        started.current = false;
        setError(e instanceof Error ? e.message : 'failed');
      });
  }, [ids]);

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

  // A link to one panel's anchor loads the card.
  useEffect(() => {
    if (ids.includes(window.location.hash.slice(1))) load();
  }, [ids, load]);

  const figs = ids.map((id) => full?.[id] ?? previews[id]!);
  const first = figs[0]!;
  const csv = useCallback(() => {
    if (!full) return;
    const text = ids.map((id) => figureCsv(full[id]!, run)).join('\n');
    const blob = new Blob([text], {type: 'text/csv;charset=utf-8'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${syncKey}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, [full, ids, run, syncKey]);

  // The legend of the first panel drives every panel, matched by pack.
  const hiddenPacks = useMemo(
    () => new Set(first.series.filter((s) => hidden.has(s.id)).map((s) => s.pack)),
    [first, hidden],
  );
  const hiddenFor = (fig: Fig) => new Set(fig.series.filter((s) => hiddenPacks.has(s.pack)).map((s) => s.id));

  return (
    <article className="tw-card tw-stack" ref={root} data-ready={full && Panel ? '1' : '0'}>
      <header className="tw-card-head">
        <h3>{title}</h3>
      </header>
      <div className="tw-keyrow">
        <Legend fig={first} theme={theme} hidden={hidden} onChange={setHidden} />
        <div className="tw-actions">
          <span className="tw-btns" role="group" aria-label="Figure actions">
            <button type="button" className="tw-act" onClick={csv} disabled={!full}>
              CSV
            </button>
          </span>
        </div>
      </div>
      <CursorRow figs={figs} reads={reads} theme={theme} />
      {figs.map((fig, i) => {
        const last = i === figs.length - 1;
        const h = last ? 150 : 120;
        return (
          <section key={fig.id} id={fig.id} className="tw-panelblock" aria-label={`${fig.title}. ${summaries[fig.id]!.finding}`}>
            <h4>
              {fig.axes.y.label}, {unitLabel(fig.axes.y.unit)}
            </h4>
            <div className="tw-plot" style={{minHeight: h}}>
              {full && Panel ? (
                <Panel
                  fig={fig}
                  theme={theme}
                  height={h}
                  bare
                  syncKey={syncKey}
                  showXLabels={last}
                  hiddenExt={hiddenFor(fig)}
                  onReadout={(r) => setReads((prev) => (prev[fig.id] === r ? prev : {...prev, [fig.id]: r}))}
                />
              ) : error ? (
                <p className="tw-error" role="alert">
                  Figure {fig.id} did not load ({error}).{' '}
                  <button type="button" className="tw-linkbtn" onClick={load}>
                    Retry
                  </button>
                </p>
              ) : (
                <StaticFigure fig={fig} width={720} height={h + (last ? 30 : 0)} compact className="tw-static" titles={false} />
              )}
            </div>
          </section>
        );
      })}
      <Disclosure figs={figs} />
    </article>
  );
}

/**
 * One row for the shared cursor: the throttle under it and, per panel, the
 * value of each run, in the run's marker. Empty, it says how to use it, so the
 * row never changes height.
 */
function CursorRow({figs, reads, theme}: {figs: Fig[]; reads: Record<string, ReadoutState>; theme: 'light' | 'dark'}) {
  const first = Object.values(reads).find(Boolean);
  const x = first?.rows.find((r) => r.kind === 'hold')?.x ?? first?.x;
  return (
    <p className="tw-cursor" aria-hidden="true" data-idle={first ? undefined : '1'}>
      {first && x !== undefined ? (
        <>
          <b>
            {figs[0]!.axes.x.label} {fmtValue(x)} {unitLabel(figs[0]!.axes.x.unit)}
          </b>
          {figs.map((fig) => {
            const rows = (reads[fig.id]?.rows ?? []).filter((r) => r.kind === 'hold');
            if (!rows.length) return null;
            const st = assignStyles(fig.series, theme);
            return (
              <span key={fig.id} className="tw-cursor-item">
                {fig.axes.y.label}{' '}
                {rows.map((r) => (
                  <span key={r.id} title={plainLabel(r.label)}>
                    <svg width="10" height="10" viewBox="-6 -6 12 12" aria-hidden="true">
                      <path d={markerPath(st[r.id]?.marker ?? 'circle', 0, 0, 4)} fill={r.color} />
                    </svg>{' '}
                    <b>{fmtValue(r.y)}</b>{' '}
                  </span>
                ))}
                {unitLabel(fig.axes.y.unit)}
              </span>
            );
          })}
        </>
      ) : (
        <span>
          <span className="tw-hint-fine">Hover</span>
          <span className="tw-hint-coarse">Touch</span> a panel for the values of both runs at one throttle.
        </span>
      )}
    </p>
  );
}
