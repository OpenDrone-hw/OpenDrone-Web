import type {ProductCard as CardData} from '~/lib/testing/data.server';
import {fitShort, markLines} from '~/lib/testing/geometry';
import {assignStyles} from '~/lib/testing/palette';
import {StaticFigure} from './StaticFigure';

/**
 * The product-page entry: the plot full width as a static SVG, its key, and
 * one line with the finding and a link that opens the view in the explorer.
 * No script. A narrower drawing is swapped in below 560 px so tick labels
 * stay legible.
 */
export function ProductCard({card}: {card: CardData}) {
  const {id, summary, fig} = card;
  return (
    <aside className="testing-card" aria-label={summary.title}>
      <figure>
        <StaticFigure fig={fig} width={1200} height={380} compact className="testing-card-svg testing-card-svg-wide" />
        <StaticFigure fig={fig} width={340} height={270} compact className="testing-card-svg testing-card-svg-narrow" />
        <CardKey fig={fig} />
      </figure>
      <p className="testing-card-finding">
        {summary.finding} <a className="testing-card-link" href={`/testing#/analyse/${id}`}>Explore the recordings</a>
      </p>
    </aside>
  );
}

/** Which line is which: one entry per drawn series (recorded frames last), the fit, and the numbered marks. */
function CardKey({fig}: {fig: CardData['fig']}) {
  const styles = assignStyles(fig.series, 'light');
  const order = [...fig.series.filter((s) => s.kind !== 'frames'), ...fig.series.filter((s) => s.kind === 'frames')];
  const marks = markLines(fig);
  // One run: name the reduction, not the run, which the caption already names.
  const oneRun = new Set(fig.series.map((s) => s.label.split(',')[0])).size === 1;
  const name = (s: (typeof order)[number]) =>
    oneRun && s.kind === 'frames' ? 'Every recorded sample'
    : oneRun && s.kind === 'hold' ? 'Median per throttle hold'
    : s.kind === 'frames' ? `${s.label}, every recorded sample`
    : s.label;
  if (order.length < 2 && !fig.fit && !marks.length) return null;
  return (
    <ul className="testing-card-key">
      {order.length > 1 || fig.fit
        ? order.map((s) => {
            const st = styles[s.id]!;
            return (
              <li key={s.id}>
                <svg width="22" height="10" aria-hidden="true">
                  {s.kind === 'frames' ? (
                    <g fill={st.colorCss} fillOpacity={0.5}>
                      <circle cx="5" cy="5" r="1.6" />
                      <circle cx="11" cy="5" r="1.6" />
                      <circle cx="17" cy="5" r="1.6" />
                    </g>
                  ) : (
                    <line x1="1" x2="21" y1="5" y2="5" stroke={st.colorCss} strokeWidth="2" strokeDasharray={st.dash.length ? st.dash.join(' ') : undefined} />
                  )}
                </svg>
                {name(s)}
              </li>
            );
          })
        : null}
      {fig.fit ? (
        <li>
          <svg width="22" height="10" aria-hidden="true">
            <line x1="1" x2="21" y1="5" y2="5" stroke="currentColor" strokeWidth="2" strokeDasharray="7 4" />
          </svg>
          Square-law fit, {fitShort(fig.fit.k, fig.fit.unit)}
        </li>
      ) : null}
      {marks.map((m) => (
        <li key={`m${m.no}`}>
          <span className="testing-card-mark" aria-hidden="true">{m.no}</span>
          {m.text}
        </li>
      ))}
    </ul>
  );
}
