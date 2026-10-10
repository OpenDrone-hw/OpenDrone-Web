import type {Fig, TestingIndex} from '~/lib/testing/types';
import {FigureCard} from './FigureCard';

/** A run line that states the run's own state, shown apart from the setup. */
const STATE = /^Run state:/;

/**
 * One product: its name, what is and is not measured, the setup of each run
 * stated once, then its figures.
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
  const [lead, ...rest] = ids;
  const runIds = [...new Set(ids.map((id) => index.figures[id]!.runId))];
  const cov = product.coverage;
  const card = (id: string, size: 'wide' | 'half') => (
    <FigureCard
      key={id}
      id={id}
      summary={index.figures[id]!}
      run={index.runs[index.figures[id]!.runId]}
      preview={previews[id]!}
      size={size}
      showRun={runIds.length > 1}
    />
  );
  return (
    <section className="tw-product" id={product.handle}>
      <h2>{product.name}</h2>
      {cov ? (
        <p className="tw-coverage">
          <span>
            <b>Measured</b> {cov.done.join(', ')}
          </span>
          {cov.gaps?.length ? (
            <span>
              <b>Not measured</b> {cov.gaps.join(', ')}
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="tw-runs">
        {runIds.map((rid) => {
          const run = index.runs[rid];
          if (!run) return null;
          const state = run.setup.find((l) => STATE.test(l));
          return (
            <div key={rid} className="tw-run" role="group" aria-label={`Run ${rid}`}>
              <h3>
                <span>Run</span> <code>{rid.replace(/-\d{4}-\d{2}-\d{2}$/, '')}</code> <time>{run.date}</time>
              </h3>
              {runIds.length > 1 ? <p className="tw-run-chip">{run.chip}</p> : null}
              {state ? <p className="tw-state">{state.replace(/^Run state: /, 'State: ')}</p> : null}
              <details className="tw-run-more">
                <summary>Full setup</summary>
                <ul>
                  {run.setup
                    .filter((l) => !STATE.test(l))
                    .map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                </ul>
              </details>
            </div>
          );
        })}
      </div>
      {lead ? card(lead, 'wide') : null}
      {rest.length ? <div className="tw-grid">{rest.map((id) => card(id, 'half'))}</div> : null}
    </section>
  );
}
