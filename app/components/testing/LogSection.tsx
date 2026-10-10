import {anchorFor, figureLabel, type Numbered} from '~/lib/testing/layout';
import type {TestingIndex} from '~/lib/testing/types';

/** Appendix A of the report: the engineering log, newest first, one row per step. */
export function LogSection({index, numbers}: {index: TestingIndex; numbers: Numbered[]}) {
  const names = Object.fromEntries(index.products.map((p) => [p.handle, p.name]));
  return (
    <section className="tr-section" id="log">
      <h2>A Engineering log</h2>
      <table className="tr-log">
        <colgroup>
          <col style={{width: '14%'}} />
          <col style={{width: '15%'}} />
          <col />
          <col style={{width: '12%'}} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Unit</th>
            <th scope="col">Result</th>
            <th scope="col" className="tr-num">
              Figure
            </th>
          </tr>
        </thead>
        <tbody>
          {index.log.map((e) => {
            const fig = e.figureId ? figureLabel(numbers, index, e.figureId) : null;
            return (
              <tr key={e.id} id={`log-${e.id}`}>
                <td className="tr-date">
                  <time dateTime={e.date}>{e.date}</time>
                </td>
                <td>{names[e.product] ?? e.product}</td>
                <td>
                  {e.tested} {e.saw}
                  {e.changed ? ` Change: ${e.changed}` : ''}
                </td>
                <td className="tr-num">
                  {fig && e.figureId ? <a href={`#${anchorFor(index, e.figureId)}`}>{fig.replace('Figure ', '')}</a> : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
