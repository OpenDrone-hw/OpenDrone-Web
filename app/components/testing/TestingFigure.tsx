import {Txt} from '~/components/Txt';
import type {Figure} from '~/lib/testing-content';
import {TestChart} from './TestChart';

/** A chart with the setup, finding, source run and caveats the reader needs to judge it. */
export function TestingFigure({figure}: {figure: Figure}) {
  return (
    <figure className="testing-figure" id={figure.id}>
      <figcaption className="testing-figure-title">{figure.title}</figcaption>
      <TestChart figure={figure} />
      <p className="testing-finding">{figure.finding}</p>
      <dl className="testing-meta">
        <div>
          <dt>
            <Txt id="testing.setup_label" />
          </dt>
          <dd>{figure.setup}</dd>
        </div>
        <div>
          <dt>
            <Txt id="testing.source_label" />
          </dt>
          <dd>
            <code>{figure.source.run}</code>, {figure.source.recorded}. {figure.source.reduction}
          </dd>
        </div>
        {figure.caveats.length > 0 ? (
          <div>
            <dt>
              <Txt id="testing.caveats_label" />
            </dt>
            <dd>
              <ul>
                {figure.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>
    </figure>
  );
}
