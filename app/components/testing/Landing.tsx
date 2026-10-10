import type {Tile} from '~/lib/testing/data.server';
import {anchorFor, isDuplicate} from '~/lib/testing/layout';
import type {TestingIndex} from '~/lib/testing/types';

/**
 * What this page is, the latest headline numbers, and a way to every figure.
 * The numbers are read from the figure files, not typed here.
 */
export function Landing({index, tiles}: {index: TestingIndex; tiles: Tile[]}) {
  const [latestId, latest] =
    Object.entries(index.runs).sort((a, b) => b[1].date.localeCompare(a[1].date) || a[0].localeCompare(b[0]))[0] ?? [];
  const state = latest?.setup
    .find((l) => l.startsWith('Run state:'))
    ?.replace(/^Run state: /, '')
    .split(/[;.]/)[0]!
    .trim();
  return (
    <section className="tw-landing" aria-labelledby="tw-title">
      <h1 id="tw-title">Test results</h1>
      <p className="tw-lede">
        Bench measurements{state ? `, ${state}` : ''}. Latest: {latest?.date}, {latest ? (latest.setupShort ?? latest.chip) : ''}.
      </p>
      {tiles.length ? <p className="tw-tilecap">{tiles[0]!.sub}. Hold medians, not peaks.</p> : null}
      {tiles.length ? (
        <ul className="tw-tiles" aria-label={`Latest run ${latestId ?? ''}`}>
          {tiles.map((t) => (
            <li key={t.id}>
              <a href={`#${anchorFor(index, t.id)}`}>
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
      <details className="tw-index">
        <summary>All figures</summary>
        <nav aria-label="All figures">
          {index.products.map((p) => (
            <p key={p.handle}>
              <b>{p.name}</b>
              {p.figures
                .filter((id) => index.figures[id] && !isDuplicate(index, id))
                .map((id) => (
                  <a key={id} href={`#${id}`}>
                    {index.figures[id]?.title}
                  </a>
                ))}
            </p>
          ))}
        </nav>
      </details>
    </section>
  );
}
