import {useState} from 'react';
import type {TestingIndex} from '~/lib/testing/types';
import {LogRow} from './LogRow';

/** The engineering log, with one chip per product to narrow it. All entries are in the page without a script. */
export function LogSection({index}: {index: TestingIndex}) {
  const [only, setOnly] = useState<string | null>(null);
  const names = Object.fromEntries(index.products.map((p) => [p.handle, p.name]));
  const handles = [...new Set(index.log.map((e) => e.product))];
  return (
    <section className="tw-product tw-log" id="log">
      <h2>Engineering log</h2>
      <p className="tw-sub">Each step: what was tested, what was seen, what changed.</p>
      <div className="tw-filter" role="group" aria-label="Filter the log by product">
        <button type="button" className="tw-chipbtn" aria-pressed={only === null} onClick={() => setOnly(null)}>
          All
        </button>
        {handles.map((h) => (
          <button key={h} type="button" className="tw-chipbtn" aria-pressed={only === h} onClick={() => setOnly(only === h ? null : h)}>
            {names[h] ?? h}
          </button>
        ))}
      </div>
      <ol className="tw-steps">
        {index.log
          .filter((e) => !only || e.product === only)
          .map((e) => (
            <LogRow
              key={e.id}
              entry={e}
              productName={names[e.product] ?? e.product}
              figureTitle={e.figureId ? index.figures[e.figureId]?.title : undefined}
            />
          ))}
      </ol>
    </section>
  );
}
