import {Link} from 'react-router';
import type {ProductCard as CardData} from '~/lib/testing/data.server';
import {StaticFigure} from './StaticFigure';

/**
 * The product-page entry, set like a figure of the test report: a small plot
 * as a static SVG with axis titles and units, its caption line, the finding,
 * and a link to the full figure in the report. No script. A second, narrower
 * drawing is swapped in below 560 px so tick labels stay legible.
 */
export function ProductCard({card}: {card: CardData}) {
  const {id, summary, date, fig, state} = card;
  return (
    <aside className="testing-card" aria-label="Measured on the bench">
      <figure>
        <StaticFigure fig={fig} width={640} height={300} compact className="testing-card-svg testing-card-svg-wide" />
        <StaticFigure fig={fig} width={340} height={270} compact className="testing-card-svg testing-card-svg-narrow" />
        <figcaption>
          <b>{summary.title}.</b> {summary.chip}. Bench test <time dateTime={date}>{date}</time>
          {state ? `, ${state.split(/[;.]/)[0]!.trim().toLowerCase()}` : ''}.
        </figcaption>
      </figure>
      <p className="testing-card-finding">{summary.finding}</p>
      <Link className="testing-card-link" to={`/testing#${id}`} prefetch="intent">
        Test report, {summary.title.toLowerCase()}
      </Link>
    </aside>
  );
}
