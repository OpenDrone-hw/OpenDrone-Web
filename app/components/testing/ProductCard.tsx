import {Link} from 'react-router';
import type {ProductCard as CardData} from '~/lib/testing/data.server';
import {StaticFigure} from './StaticFigure';

/**
 * The product-page card: the featured figure as a static SVG, its finding and
 * the setup chip, with a link to the full figure in the workspace. No script.
 * A second, narrower drawing is swapped in below 560 px so tick labels stay at
 * 12 px.
 */
export function ProductCard({card}: {card: CardData}) {
  const {id, summary, date, fig} = card;
  return (
    <aside className="testing-card" aria-label="Measured on the bench">
      <p className="testing-card-meta">
        <b>TESTED</b>
        <span>{summary.runId}</span>
        <span>{date}</span>
        {summary.caveats ? <span>{summary.caveats} caveats</span> : null}
      </p>
      <h3>{summary.title}</h3>
      <p className="testing-card-finding">{summary.finding}</p>
      <div className="testing-card-plot">
        <StaticFigure fig={fig} width={600} height={220} compact className="testing-card-svg testing-card-svg-wide" />
        <StaticFigure fig={fig} width={340} height={220} compact className="testing-card-svg testing-card-svg-narrow" />
      </div>
      <p className="testing-card-chip">{summary.chip}</p>
      <Link className="testing-card-link" to={`/testing#${id}`} prefetch="intent">
        Open in testing
      </Link>
    </aside>
  );
}
