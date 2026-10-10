import {Link} from 'react-router';
import {Txt} from '~/components/Txt';
import type {Figure} from '~/lib/testing-content';
import {TestChart} from './TestChart';

/**
 * Body of the product-page Testing chapter: one sentence of context, the
 * featured chart, its finding and a link to the full page. The route wraps it
 * in its `Chapter` frame, which is local to that file.
 */
export function TestingChapterBody({figure}: {figure: Figure}) {
  return (
    <>
      <p className="chapter-body testing-chapter-blurb">
        {figure.blurb ?? figure.title}
      </p>
      <p className="testing-chapter-run">
        <code>{figure.source.run}</code>, {figure.source.recorded}
      </p>
    </>
  );
}

export function TestingChapterWide({figure, handle}: {figure: Figure; handle: string}) {
  return (
    <div className="testing-chapter-wide">
      <TestChart figure={figure} compact />
      <p className="testing-finding">{figure.finding}</p>
      <ul className="testing-chapter-caveats">
        {figure.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Link className="testing-chapter-link" to={`/testing#${handle}`} prefetch="intent">
        <Txt id="testing.chapter_link" />
      </Link>
    </div>
  );
}
