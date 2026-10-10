import {Link} from 'react-router';
import type {ProductCard as CardData} from '~/lib/testing/data.server';
import {StaticFigure} from './StaticFigure';

/**
 * The product-page card: the featured figure as a static SVG with axis titles,
 * units and its last value, the finding, and a link to the full figure in the
 * workspace. No script. A second, narrower drawing is swapped in below 560 px so
 * tick labels stay at 11 px.
 */
export function ProductCard({card}: {card: CardData}) {
  const {id, summary, date, fig, state} = card;
  return (
    <aside className="testing-card" aria-label="Measured on the bench">
      <p className="testing-card-meta">
        <b>Bench test</b>
        <time dateTime={date}>{date}</time>
        {state ? <span>{state}</span> : null}
      </p>
      <h3>{summary.title}</h3>
      <p className="testing-card-finding">{summary.finding}</p>
      <div className="testing-card-plot">
        <StaticFigure fig={fig} width={640} height={300} compact className="testing-card-svg testing-card-svg-wide" />
        <StaticFigure fig={fig} width={340} height={270} compact className="testing-card-svg testing-card-svg-narrow" />
      </div>
      <p className="testing-card-chip">{summary.chip}</p>
      <Link className="testing-card-link" to={`/testing#${id}`} prefetch="intent">
        Open {summary.title.toLowerCase()} <span aria-hidden="true">&rarr;</span>
      </Link>
    </aside>
  );
}
