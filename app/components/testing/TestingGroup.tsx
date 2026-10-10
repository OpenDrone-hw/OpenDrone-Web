import {useState} from 'react';
import {Txt} from '~/components/Txt';
import type {Figure} from '~/lib/testing-content';
import {TestChart} from './TestChart';

/**
 * Several quantities from the same runs, one small chart each, sharing one
 * hover position. Setup and source come from the first figure; caveats are
 * the union with duplicates removed.
 */
export function TestingGroup({figures}: {figures: Figure[]}) {
  const [cursor, setCursor] = useState<number | null>(null);
  const first = figures[0];
  if (!first) return null;
  const caveats = [...new Set(figures.flatMap((f) => f.caveats))];
  return (
    <div className="testing-group" id={first.group}>
      <div className="testing-group-grid">
        {figures.map((f) => (
          <figure className="testing-figure testing-figure--small" key={f.id} id={f.id}>
            <figcaption className="testing-figure-title">{f.title}</figcaption>
            <TestChart figure={f} compact cursor={cursor} onCursor={setCursor} />
            <p className="testing-finding">{f.finding}</p>
          </figure>
        ))}
      </div>
      <dl className="testing-meta">
        <div>
          <dt>
            <Txt id="testing.setup_label" />
          </dt>
          <dd>{first.setup}</dd>
        </div>
        <div>
          <dt>
            <Txt id="testing.source_label" />
          </dt>
          <dd>
            <code>{first.source.run}</code>, {first.source.recorded}. {first.source.reduction}
          </dd>
        </div>
        <div>
          <dt>
            <Txt id="testing.caveats_label" />
          </dt>
          <dd>
            <ul>
              {caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
    </div>
  );
}
