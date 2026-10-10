import type {Fig, TestingIndex} from '~/lib/testing/types';
import {blocksOf, type Block} from '~/lib/testing/select';
import {FigureCard} from './FigureCard';
import {StackCard} from './StackCard';

/** A run line that states the run's own state, shown as a badge. */
const STATE = /^Run state:/;

/** "Run state: draft, not validated; no scope." becomes "Draft, not validated". */
function stateBadge(setup: string[]): string | null {
  const line = setup.find((l) => STATE.test(l));
  if (!line) return null;
  const t = line.replace(STATE, '').split(/[;.]/)[0]!.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : null;
}

/**
 * One product: a header band with its name, the state of its run and what is
 * not measured, the setup of each run stated once, then its figures.
 */
export function ProductSection({
  product,
  index,
  previews,
}: {
  product: TestingIndex['products'][number];
  index: TestingIndex;
  previews: Record<string, Fig>;
}) {
  const ids = product.figures.filter((id) => index.figures[id] && previews[id]);
  const runIds = [...new Set(ids.map((id) => index.figures[id]!.runId))];
  const cov = product.coverage;
  const badge = runIds.map((r) => stateBadge(index.runs[r]?.setup ?? [])).find(Boolean) ?? null;
  const hasHold = ids.some((id) => previews[id]!.series.some((s) => s.kind === 'hold'));
  const blocks = blocksOf(ids, index, previews);
  const logOf = (id: string) => index.log.find((e) => e.figureId === id);
  const card = (id: string, size: 'wide' | 'half') => (
    <FigureCard
      key={id}
      id={id}
      summary={index.figures[id]!}
      run={index.runs[index.figures[id]!.runId]}
      preview={previews[id]!}
      size={size}
      showRun={runIds.length > 1}
      log={logOf(id)}
    />
  );
  const [lead, ...rest] = blocks;
  const render = (b: Block, size: 'wide' | 'half') =>
    b.kind === 'card' ? (
      card(b.id, size)
    ) : (
      <StackCard
        key={b.ids.join('+')}
        title={`Per ${previews[b.ids[0]!]!.axes.x.label.toLowerCase()} hold`}
        ids={b.ids}
        summaries={index.figures}
        run={index.runs[index.figures[b.ids[0]!]!.runId]}
        previews={previews}
        syncKey={`${product.handle}-${b.ids[0]}`}
      />
    );
  return (
    <section className="tw-product" id={product.handle}>
      <header className="tw-prodhead">
        <div className="tw-prodtitle">
          <h2>{product.name}</h2>
          {badge ? <span className="tw-badge">{badge}</span> : null}
        </div>
        <p className="tw-prodmeta">
          {runIds.map((rid) => (
            <span key={rid}>
              <code>{rid.replace(/-\d{4}-\d{2}-\d{2}$/, '')}</code> <time>{index.runs[rid]?.date}</time>
            </span>
          ))}
        </p>
      </header>
      {cov?.gaps?.length ? (
        <p className="tw-chips">
          <span className="tw-chiplabel">Not measured</span>
          {cov.gaps.map((g) => (
            <span key={g} className="tw-chip">
              {g}
            </span>
          ))}
        </p>
      ) : null}
      <div className="tw-runs">
        {runIds.map((rid) => {
          const run = index.runs[rid];
          if (!run) return null;
          return (
            <div key={rid} className="tw-run" role="group" aria-label={`Run ${rid}`}>
              <p className="tw-run-chip">{run.chip}</p>
              <details className="tw-run-more">
                <summary>Full setup</summary>
                <ul>
                  {run.setup.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              </details>
            </div>
          );
        })}
      </div>
      {hasHold ? (
        <p className="tw-markkey">Marker: hold median. Whisker: 25th to 75th percentile of the hold.</p>
      ) : null}
      {lead ? render(lead, 'wide') : null}
      {rest.length ? <div className="tw-grid">{rest.map((b) => render(b, 'half'))}</div> : null}
    </section>
  );
}
