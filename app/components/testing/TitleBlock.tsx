import type {TestingIndex} from '~/lib/testing/types';

/** "Run state: draft, not validated; no scope." becomes "Draft, not validated". */
export function runState(setup: string[]): string | null {
  const line = setup.find((l) => /^Run state:/.test(l));
  if (!line) return null;
  const t = line.replace(/^Run state:/, '').split(/[;.]/)[0]!.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : null;
}

/**
 * The title block of the report: title, one header line of keys and values,
 * a short statement of what the document is, and its contents. The values are
 * read from the index, not typed here.
 */
export function TitleBlock({index}: {index: TestingIndex}) {
  const runs = Object.entries(index.runs);
  const dates = runs.map(([, r]) => r.date).sort();
  const states = [...new Set(runs.map(([, r]) => runState(r.setup)).filter(Boolean))];
  return (
    <section aria-labelledby="tr-title">
      <h1 id="tr-title">Test results</h1>
      <p className="tr-head">
        <span>
          <b>Scope</b> {index.products.map((p) => p.name).join(', ')}
        </span>
        <span>
          <b>Runs</b> {runs.length}, {dates[0]} to {dates[dates.length - 1]}
        </span>
        <span>
          <b>Status</b> {states.length === 1 ? states[0] : 'per section'}
        </span>
        <span>
          <b>Exported</b> {index.built}
        </span>
      </p>
      <p>
        Bench and field measurements of OpenDrone boards. Each section names its setup, the run behind each figure and what was not measured.
        One unit and one capture per run unless a section says otherwise.
      </p>
      <ol className="tr-contents" aria-label="Contents">
        {index.products.map((p, i) => (
          <li key={p.handle}>
            <a href={`#${p.handle}`}>
              <span>{i + 1}</span> {p.name}
            </a>
          </li>
        ))}
        {index.log.length ? (
          <li>
            <a href="#log">
              <span>A</span> Engineering log
            </a>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
