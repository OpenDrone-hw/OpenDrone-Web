import {tableRows} from '~/lib/testing/export';
import {unitLabel} from '~/lib/testing/scale';
import {visibleCaveat} from '~/lib/testing/layout';
import {caveatFlagged, caveatText, type Fig} from '~/lib/testing/types';

/**
 * One flagged caveat is visible under the card, short. Everything else is one
 * disclosure, Details: the other caveats, the plotted values, how they were
 * reduced and the source.
 */
export function Disclosure({figs}: {figs: Fig[]}) {
  const uniq = <T,>(list: T[], key: (t: T) => string) => [...new Map(list.map((t) => [key(t), t])).values()];
  const caveats = uniq(figs.flatMap((f) => f.caveats), caveatText);
  const shown = visibleCaveat(figs);
  const rest = caveats.filter((c) => caveatText(c) !== shown?.text);
  const reductions = uniq(figs.filter((f) => f.reduction).map((f) => f.reduction!), (t) => t);
  const cites = uniq(figs.filter((f) => f.cite).map((f) => f.cite!), (t) => t);
  return (
    <div className="tw-notes">
      {shown ? (
        <p className="tw-flag">
          <b aria-hidden="true">!</b>
          <span className="tw-sr">Caveat: </span>
          {shown.text}
        </p>
      ) : null}
      <details className="tw-details">
        <summary>
          Details
          <span>{rest.length ? `${rest.length} more caveats, values, source` : 'values, source'}</span>
        </summary>
        <div className="tw-details-body">
          {rest.length ? (
            <>
              <h4>Caveats</h4>
              <ul className="tw-cav">
                {rest.map((c) => (
                  <li key={caveatText(c)} data-flag={caveatFlagged(c) ? '1' : undefined}>
                    {caveatText(c)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
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
  );
}
