import type {LogEntry} from '~/lib/testing/types';

/** One line per entry; opens to what was tested, what was seen, what changed. */
export function headline(text: string, words = 7): string {
  const w = text.split(/\s+/);
  return w.length <= words ? text : `${w.slice(0, words).join(' ')}...`;
}

export function LogRow({entry, productName}: {entry: LogEntry; productName: string}) {
  return (
    <details className="tw-log-row">
      <summary>
        <time dateTime={entry.date}>{entry.date}</time>
        <span className="tw-chip tw-chip-mono">{productName}</span>
        <span className="tw-log-line">{headline(entry.tested)}</span>
      </summary>
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
      {entry.figureId ? <a href={`#${entry.figureId}`}>Show the figure</a> : null}
    </details>
  );
}
