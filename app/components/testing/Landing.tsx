import type {Tile} from '~/lib/testing/data.server';
import {summarize} from '~/lib/testing/select';
import type {TestingIndex} from '~/lib/testing/types';

/**
 * What this page is, the latest headline numbers, and a way to every figure.
 * The numbers are read from the figure files, not typed here.
 */
export function Landing({index, tiles}: {index: TestingIndex; tiles: Tile[]}) {
  const sum = summarize(index);
  const [latestId, latest] =
    Object.entries(index.runs).sort((a, b) => b[1].date.localeCompare(a[1].date) || a[0].localeCompare(b[0]))[0] ?? [];
  const state = latest?.setup.find((l) => l.startsWith('Run state:'))?.replace(/^Run state: /, '').replace(/\.$/, '');
  return (
    <section className="tw-landing" aria-labelledby="tw-title">
      <h1 id="tw-title">Test results</h1>
      <p className="tw-lede">
        Measurements from the Incutec bench, one unit per test. Latest run {latest?.date}
        {latest ? `: ${latest.chip[0]!.toLowerCase()}${latest.chip.slice(1)}` : ''}
        {state ? `. ${state[0]!.toUpperCase()}${state.slice(1)}.` : '.'}
      </p>
      {tiles.length ? <p className="tw-tilecap">{tiles[0]!.sub}. Hold medians, not peaks.</p> : null}
      {tiles.length ? (
        <ul className="tw-tiles" aria-label={`Latest run ${latestId ?? ''}`}>
          {tiles.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`}>
                <span className="tw-tile-label">{t.label}</span>
                <span className="tw-tile-value">
                  {t.value}
                  <small>{t.unit}</small>
                </span>
                <span className="tw-tile-note">{t.note}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="tw-counts">
        <div>
          <dt>Figures</dt>
          <dd>{sum.figures}</dd>
        </div>
        <div>
          <dt>Runs</dt>
          <dd>{sum.runs}</dd>
        </div>
        <div>
          <dt>Products</dt>
          <dd>{sum.products}</dd>
        </div>
        <div>
          <dt>Last run</dt>
          <dd>{sum.lastRun}</dd>
        </div>
      </dl>
      <p className="tw-hintline">
        <span className="tw-hint-fine">Hover for values, drag to zoom, arrow keys step through points.</span>
        <span className="tw-hint-coarse">Touch for values, pinch to zoom.</span>
      </p>
      <details className="tw-jump">
        <summary>All figures</summary>
        <div>
          {index.products.map((p) => (
            <p key={p.handle}>
              <b>{p.name}</b>
              {p.figures.map((id) => (
                <a key={id} href={`#${id}`}>
                  {index.figures[id]?.title}
                </a>
              ))}
            </p>
          ))}
        </div>
      </details>
    </section>
  );
}
