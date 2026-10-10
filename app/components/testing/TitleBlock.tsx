import type {Numbered} from '~/lib/testing/layout';
import type {TestingIndex} from '~/lib/testing/types';

/** "Run state: draft, not validated; no scope." becomes "Draft, not validated". */
export function runState(setup: string[]): string | null {
  const line = setup.find((l) => /^Run state:/.test(l));
  if (!line) return null;
  const t = line.replace(/^Run state:/, '').split(/[;.]/)[0]!.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : null;
}

/**
 * The title block of the report: the title and one inline row of scope, runs and status, as the exports
 * set their metadata. The scope names link to their sections. The values are read from the index, not typed here.
 */
export function TitleBlock({index}: {index: TestingIndex; numbers?: Numbered[]}) {
  const runs = Object.entries(index.runs);
  const dates = runs.map(([, r]) => r.date).sort();
  const states = [...new Set(runs.map(([, r]) => runState(r.setup)).filter(Boolean))];
  return (
    <section aria-labelledby="tr-title">
      <h1 id="tr-title">OpenDrone test report, exported {index.built}</h1>
      <p className="tr-meta">
        <span>
          <b>Scope</b>{' '}
          {index.products.map((p, i) => (
            <span key={p.handle}>
              {i ? ', ' : ''}
              <a href={`#${p.handle}`}>{p.name}</a>
            </span>
          ))}
          {index.log.length ? (
            <>
              , <a href="#log">engineering log</a>
            </>
          ) : null}
        </span>
        <span>
          <b>Runs</b> {runs.length}, {dates[0]} to {dates[dates.length - 1]}
        </span>
        <span>
          <b>Status</b> {states.length === 1 ? states[0] : 'per section'}
        </span>
      </p>
    </section>
  );
}
