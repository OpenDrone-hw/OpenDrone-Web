import type {ReactNode} from 'react';
import type {LogEntry} from '~/lib/testing/types';

/** The first `n` sentences of a text, whole. Never cut with an ellipsis. */
export function sentences(text: string, n = 1): string {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const m = /^.*?[.!?](?=\s|$)/s.exec(text.slice(at).trimStart());
    if (!m) return text;
    at = text.indexOf(m[0], at) + m[0].length;
  }
  return text.slice(0, at);
}
export const firstSentence = (text: string) => sentences(text, 1);

/** How many sentences a text has. */
export function countSentences(text: string): number {
  return (text.match(/[.!?](?=\s|$)/g) ?? []).length || 1;
}

const NUMBER = /-?\d+(?:\.\d+)?\s?(?:percent|rpm|dBm|dB|km|A|V|g|C|s)\b/g;

/** Bold the numbers that carry a unit, so the figure of an entry is found at a glance. */
export function emphasize(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(NUMBER)) {
    const i = m.index ?? 0;
    if (i > at) out.push(text.slice(at, i));
    out.push(<strong key={i}>{m[0]}</strong>);
    at = i + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * One step of the engineering log: what was tested, what was seen, what
 * changed, one sentence each. The remaining sentences are one fold that says
 * how many there are. A step that changed nothing says so once, in its head,
 * and has no empty row. A step with a figure links to it and sits on a filled
 * point of the spine.
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
  const rest = (t: string | null) => (t && t !== firstSentence(t) ? t.slice(firstSentence(t).length).trim() : '');
  const tails = [
    ['Tested', rest(entry.tested)],
    ['Saw', rest(entry.saw)],
    ['Changed', rest(entry.changed)],
  ].filter(([, t]) => t) as Array<[string, string]>;
  const n = tails.reduce((a, [, t]) => a + countSentences(t), 0);
  return (
    <li className="tw-step" id={`log-${entry.id}`} data-product={entry.product} data-fig={entry.figureId ? '1' : undefined}>
      <div className="tw-step-head">
        <time dateTime={entry.date}>{entry.date}</time>
        <span>{productName}</span>
        {entry.figureId ? (
          <a className="tw-figchip" href={`#${entry.figureId}`}>
            Figure: {figureTitle ?? entry.figureId}
          </a>
        ) : null}
        {entry.changed ? null : <em className="tw-nochange">No change</em>}
      </div>
      <dl className="tw-flow">
        <dt>Tested</dt>
        <dd>{firstSentence(entry.tested)}</dd>
        <dt>Saw</dt>
        <dd>{emphasize(firstSentence(entry.saw))}</dd>
        {entry.changed ? (
          <>
            <dt>Changed</dt>
            <dd>{firstSentence(entry.changed)}</dd>
          </>
        ) : null}
      </dl>
      {tails.length ? (
        <details className="tw-more tw-fold">
          <summary>
            Rest ({n} {n === 1 ? 'sentence' : 'sentences'})
          </summary>
          {tails.map(([k, t]) => (
            <p key={k}>
              <b>{k}</b> {t}
            </p>
          ))}
        </details>
      ) : null}
    </li>
  );
}
