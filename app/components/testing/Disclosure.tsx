import {tableRows} from '~/lib/testing/export';
import {unitLabel} from '~/lib/testing/scale';
import {caveatFlagged, caveatText, type Caveat, type Fig} from '~/lib/testing/types';

/**
 * Flagged caveats are visible. The other caveats are one fold, the plotted
 * values, how they were reduced and the source another, each named for what it
 * holds.
 */
export function Disclosure({figs}: {figs: Fig[]}) {
  const uniq = <T,>(list: T[], key: (t: T) => string) => [...new Map(list.map((t) => [key(t), t])).values()];
  const caveats = uniq(figs.flatMap((f) => f.caveats), caveatText);
  const flagged = caveats.filter(caveatFlagged);
  const rest = caveats.filter((c) => !caveatFlagged(c));
  const reductions = uniq(figs.filter((f) => f.reduction).map((f) => f.reduction!), (t) => t);
  const cites = uniq(figs.filter((f) => f.cite).map((f) => f.cite!), (t) => t);
  return (
    <div className="tw-notes">
      {flagged.length ? (
        <ul className="tw-cav">
          {flagged.map((c) => (
            <li key={caveatText(c)} data-flag="1">
              {caveatText(c)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="tw-folds">
        {rest.length ? (
          <details className="tw-details">
            <summary>
              {flagged.length ? 'More caveats' : 'Caveats'} ({rest.length})
            </summary>
            <ul className="tw-cav">
              {rest.map((c) => (
                <li key={caveatText(c)}>{caveatText(c)}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <details className="tw-details">
          <summary>Values and source</summary>
          <div className="tw-details-body">
            {figs.map((fig) => {
              const rows = tableRows(fig);
              return rows ? (
                <div key={fig.id}>
                  <h4>{figs.length > 1 ? `Values, ${fig.title}` : 'Values'}</h4>
                  <table className="tw-table">
                    <thead>
                      <tr>
                        <th scope="col">Series</th>
                        <th scope="col">
                          {fig.axes.x.label} ({unitLabel(fig.axes.x.unit)})
                        </th>
                        <th scope="col">
                          {fig.axes.y.label} ({unitLabel(fig.axes.y.unit)})
                        </th>
                        <th scope="col">25th to 75th</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          <td>{r.series.replace(/, hold median.*$/, '')}</td>
                          <td>{r.x}</td>
                          <td>{r.y}</td>
                          <td>{r.band}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null;
            })}
            {reductions.length ? (
              <>
                <h4>Reduction</h4>
                {reductions.map((t) => (
                  <p key={t}>{t}</p>
                ))}
              </>
            ) : null}
            {cites.length ? (
              <>
                <h4>Source</h4>
                {cites.map((t) => (
                  <p key={t} className="tw-cite">
                    {t}
                  </p>
                ))}
              </>
            ) : null}
          </div>
        </details>
      </div>
    </div>
  );
}
