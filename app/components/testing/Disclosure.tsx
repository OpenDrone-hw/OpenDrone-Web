import {tableRows} from '~/lib/testing/export';
import {caveatFlagged, caveatText, type Caveat, type Fig} from '~/lib/testing/types';

/**
 * A flagged caveat is visible; the others sit one fold down. The rest, how the
 * numbers were reduced, the source and the plotted values sit one fold down.
 */
export function Disclosure({fig}: {fig: Fig}) {
  const {caveats, reduction, cite} = fig;
  const ordered: Caveat[] = [...caveats.filter(caveatFlagged), ...caveats.filter((c) => !caveatFlagged(c))];
  const first = ordered[0] && caveatFlagged(ordered[0]) ? ordered[0] : undefined;
  const rest = first ? ordered.slice(1) : ordered;
  const rows = tableRows(fig);
  return (
    <div className="tw-notes">
      {first ? (
        <ul className="tw-cav">
          <li data-flag={caveatFlagged(first) ? '1' : undefined}>{caveatText(first)}</li>
        </ul>
      ) : null}
      <details className="tw-details">
        <summary>{rest.length ? `${rest.length} ${first ? 'more ' : ''}${rest.length === 1 ? 'caveat' : 'caveats'}, values and source` : 'Values and source'}</summary>
        <div className="tw-details-body">
          {rest.length ? (
            <ul className="tw-cav">
              {rest.map((c) => (
                <li key={caveatText(c)} data-flag={caveatFlagged(c) ? '1' : undefined}>
                  {caveatText(c)}
                </li>
              ))}
            </ul>
          ) : null}
          {reduction ? (
            <>
              <h4>Reduction</h4>
              <p>{reduction}</p>
            </>
          ) : null}
          {rows ? (
            <>
              <h4>Values</h4>
              <table className="tw-table">
                <thead>
                  <tr>
                    <th scope="col">Series</th>
                    <th scope="col">{fig.axes.x.label} ({fig.axes.x.unit})</th>
                    <th scope="col">{fig.axes.y.label} ({fig.axes.y.unit})</th>
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
            </>
          ) : null}
          {cite ? (
            <>
              <h4>Source</h4>
              <p className="tw-cite">{cite}</p>
            </>
          ) : null}
        </div>
      </details>
    </div>
  );
}
