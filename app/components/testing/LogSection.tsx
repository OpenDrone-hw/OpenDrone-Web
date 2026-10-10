import {anchorFor, figureLabel, type Numbered} from '~/lib/testing/layout';
import type {LogEntry, TestingIndex} from '~/lib/testing/types';

/** Appendix A of the report: the engineering log, newest first, grouped by date. */
export function LogSection({index, numbers}: {index: TestingIndex; numbers: Numbered[]}) {
  const names = Object.fromEntries(index.products.map((p) => [p.handle, p.name]));
  const days: Array<{date: string; items: LogEntry[]}> = [];
  for (const e of index.log) {
    const last = days[days.length - 1];
    if (last && last.date === e.date) last.items.push(e);
    else days.push({date: e.date, items: [e]});
  }
  return (
    <section className="tr-section" id="log">
      <h2>A Engineering log</h2>
      <table className="tr-log">
        <colgroup>
          <col style={{width: '30%'}} />
          <col style={{width: '42%'}} />
          <col style={{width: '28%'}} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Observation</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        {days.map((day) => (
          <tbody key={day.date}>
            <tr className="tr-day">
              <th scope="colgroup" colSpan={3}>
                <time dateTime={day.date}>{day.date}</time>
              </th>
            </tr>
            {day.items.map((e) => {
              const fig = e.figureId ? figureLabel(numbers, index, e.figureId) : null;
              return (
                <tr key={e.id} id={`log-${e.id}`}>
                  <td>
                    <span className="tr-logsub">{names[e.product] ?? e.product}</span> {e.tested}
                  </td>
                  <td>
                    {e.saw}
                    {fig && e.figureId ? (
                      <>
                        {' '}
                        <a href={`#${anchorFor(index, e.figureId)}`}>{fig}</a>.
                      </>
                    ) : null}
                  </td>
                  <td>{e.changed ?? ''}</td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </section>
  );
}
