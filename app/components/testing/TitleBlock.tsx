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
 * The title block of the report: title, a small table of scope, runs, status and
 * export date, one sentence on what the document is, and its contents with the
 * figures each section holds. The values are read from the index, not typed here.
 */
export function TitleBlock({index, numbers}: {index: TestingIndex; numbers: Numbered[]}) {
  const runs = Object.entries(index.runs);
  const dates = runs.map(([, r]) => r.date).sort();
  const states = [...new Set(runs.map(([, r]) => runState(r.setup)).filter(Boolean))];
  const meta: Array<[string, string]> = [
    ['Scope', index.products.map((p) => p.name).join(', ')],
    ['Runs', `${runs.length}, ${dates[0]} to ${dates[dates.length - 1]}`],
    ['Status', states.length === 1 ? states[0]! : 'per section'],
    ['Exported', index.built],
  ];
  const range = (handle: string) => {
    const mine = numbers.filter((n) => index.products.find((p) => p.handle === handle)?.figures.includes(n.id));
    if (!mine.length) return '';
    const a = mine[0]!.no;
    const b = mine[mine.length - 1]!.no;
    return a === b ? `Figure ${a}` : `Figures ${a} to ${b}`;
  };
  return (
    <section aria-labelledby="tr-title">
      <h1 id="tr-title">Test results</h1>
      <dl className="tr-meta">
        {meta.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p>Bench and field measurements of OpenDrone boards, one unit and one capture per run unless a section says otherwise.</p>
      <ol className="tr-contents" aria-label="Contents">
        {index.products.map((p, i) => (
          <li key={p.handle}>
            <a href={`#${p.handle}`}>
              <span className="tr-cn">{i + 1}</span> {p.name}
            </a>
            <i aria-hidden="true" />
            <span className="tr-cr">{range(p.handle)}</span>
          </li>
        ))}
        {index.log.length ? (
          <li>
            <a href="#log">
              <span className="tr-cn">A</span> Engineering log
            </a>
            <i aria-hidden="true" />
            <span className="tr-cr">{index.log.length} steps</span>
          </li>
        ) : null}
      </ol>
    </section>
  );
}
