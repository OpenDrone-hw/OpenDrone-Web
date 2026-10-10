import {Txt} from '~/components/Txt';
import {getFigure, type TimelineItem} from '~/lib/testing-content';

/** Dated entries: what was tested, what it showed, what changed. */
export function TestingLog({items}: {items: TimelineItem[]}) {
  if (items.length === 0) return null;
  return (
    <ol className="testing-log">
      {items.map((i) => (
        <li key={i.id} className="testing-log-item">
          <time dateTime={i.date}>{i.date}</time>
          <dl>
            <div>
              <dt>
                <Txt id="testing.log_tested" />
              </dt>
              <dd>{i.tested}</dd>
            </div>
            <div>
              <dt>
                <Txt id="testing.log_saw" />
              </dt>
              <dd>{i.saw}</dd>
            </div>
            {i.changed ? (
              <div>
                <dt>
                  <Txt id="testing.log_changed" />
                </dt>
                <dd>{i.changed}</dd>
              </div>
            ) : null}
          </dl>
          {i.figureId && getFigure(i.figureId) ? (
            <a className="testing-log-fig" href={`#${i.figureId}`}>
              {getFigure(i.figureId)!.title}
            </a>
          ) : null}
          {i.commit ? <code className="testing-log-commit">{i.commit}</code> : null}
        </li>
      ))}
    </ol>
  );
}
