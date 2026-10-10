import type {LogEntry} from '~/lib/testing/types';

/** The first sentence of a text, whole. Never cut with an ellipsis. */
export function firstSentence(text: string): string {
  const m = /^.*?[.!?](?=\s|$)/s.exec(text);
  return m ? m[0] : text;
}

/**
 * One step of the engineering log: what was tested, what was seen, what
 * changed, each in its first sentence, with the rest and the figure one click
 * away. A step with no change says so.
 */
export function LogRow({
  entry,
  productName,
  figureTitle,
}: {
  entry: LogEntry;
  productName: string;
  figureTitle?: string;
}) {
  const more = [entry.tested, entry.saw, entry.changed ?? ''].some((t) => t && t !== firstSentence(t));
  return (
    <li className="tw-step">
      <div className="tw-step-head">
        <time dateTime={entry.date}>{entry.date}</time>
        <span>{productName}</span>
        {entry.figureId ? (
          <a href={`#${entry.figureId}`}>{figureTitle ?? 'Figure'}</a>
        ) : null}
      </div>
      <ol className="tw-flow">
        <li>
          <b>Tested</b>
          <p>{firstSentence(entry.tested)}</p>
        </li>
        <li>
          <b>Saw</b>
          <p>{firstSentence(entry.saw)}</p>
        </li>
        <li data-none={entry.changed ? undefined : '1'}>
          <b>Changed</b>
          <p>{entry.changed ? firstSentence(entry.changed) : 'No change recorded.'}</p>
        </li>
      </ol>
      {more ? (
        <details className="tw-more">
          <summary>Full entry</summary>
          <dl>
            <dt>Tested</dt>
            <dd>{entry.tested}</dd>
            <dt>Saw</dt>
            <dd>{entry.saw}</dd>
            {entry.changed ? (
              <>
                <dt>Changed</dt>
                <dd>{entry.changed}</dd>
              </>
            ) : null}
          </dl>
        </details>
      ) : null}
    </li>
  );
}
