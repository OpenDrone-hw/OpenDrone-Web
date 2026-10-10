import type {Fig, TestingIndex} from '~/lib/testing/types';
import {blocksOf, type Block} from '~/lib/testing/select';
import {isDuplicate} from '~/lib/testing/layout';
import {FigureCard} from './FigureCard';
import {firstSentence} from './LogRow';
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
  first = false,
}: {
  product: TestingIndex['products'][number];
  index: TestingIndex;
  previews: Record<string, Fig>;
  /** The first section of the page: its lead plot carries the reading hint. */
  first?: boolean;
}) {
  const ids = product.figures.filter(
    (id) => index.figures[id] && previews[id] && !isDuplicate(index, id),
  );
  const runIds = [...new Set(ids.map((id) => index.figures[id]!.runId))];
  const cov = product.coverage;
  const badge =
    runIds.map((r) => stateBadge(index.runs[r]?.setup ?? [])).find(Boolean) ??
    null;
  const photo = runIds.map((r) => index.runs[r]?.photo).find(Boolean);
  const hasHold = ids.some((id) =>
    previews[id]!.series.some((s) => s.kind === 'hold'),
  );
  const blocks = blocksOf(ids, index, previews);
  const logOf = (id: string) => index.log.find((e) => e.figureId === id);
  const card = (id: string, size: 'wide' | 'half', hint = false) => (
    <FigureCard
      key={id}
      id={id}
      summary={index.figures[id]!}
      run={index.runs[index.figures[id]!.runId]}
      preview={previews[id]!}
      size={size}
      showRun={runIds.length > 1}
      log={logOf(id)}
      hint={hint}
    />
  );
  const [lead, ...rest] = blocks;
  const render = (b: Block, size: 'wide' | 'half', hint = false) =>
    b.kind === 'card' ? (
      card(b.id, size, hint)
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
  // The newest step of the log that changed something and has no figure of its own to say so under.
  const loose = index.log.find(
    (e) => e.product === product.handle && e.changed && !e.figureId,
  );
  return (
    <section className="tw-product" id={product.handle}>
      <header className="tw-prodhead">
        <h2>{product.name}</h2>
        {badge ? <span className="tw-badge">{badge}</span> : null}
      </header>
      <div className="tw-intro" data-photo={photo ? '1' : undefined}>
        <dl className="tw-kv">
          <div>
            <dt>Setup</dt>
            <dd>
              {runIds.map((rid) => (
                <span key={rid} className="tw-kv-run">
                  {index.runs[rid]?.chip}
                  <small>
                    <code>{rid.replace(/-\d{4}-\d{2}-\d{2}$/, '')}</code>{' '}
                    {index.runs[rid]?.date}
                  </small>
                </span>
              ))}
            </dd>
          </div>
          {hasHold ? (
            <div>
              <dt>Markers</dt>
              <dd>Hold median, whisker 25th to 75th percentile of the hold</dd>
            </div>
          ) : null}
          {cov?.gaps?.length ? (
            <div>
              <dt>Not measured</dt>
              <dd className="tw-gaps">
                {cov.gaps.map((g) => g.toLowerCase()).join(', ')}
              </dd>
            </div>
          ) : null}
          {loose ? (
            <div>
              <dt>Last change</dt>
              <dd>
                {firstSentence(loose.changed!)}{' '}
                <a href={`#log-${loose.id}`}>Log, {loose.date}</a>
              </dd>
            </div>
          ) : null}
        </dl>
        {photo ? (
          <figure className="tw-photo">
            <img
              src={photo.src}
              width={photo.size[0]}
              height={photo.size[1]}
              alt={photo.alt}
              loading="lazy"
              decoding="async"
            />
            <figcaption>{photo.caption}</figcaption>
          </figure>
        ) : null}
      </div>
      <details className="tw-setup tw-fold">
        <summary>Full setup</summary>
        <div className="tw-runs">
          {runIds.map((rid) => {
            const run = index.runs[rid];
            if (!run) return null;
            return (
              <ul key={rid} aria-label={`Run ${rid}`}>
                {run.setup.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            );
          })}
        </div>
      </details>
      {lead ? render(lead, 'wide', first) : null}
      {rest.length ? (
        <div className="tw-grid">{rest.map((b) => render(b, 'half'))}</div>
      ) : null}
    </section>
  );
}
