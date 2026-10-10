import {anchorFor, figureLabel, type Numbered} from '~/lib/testing/layout';
import type {TestingIndex} from '~/lib/testing/types';

/** Appendix A of the report: the engineering log as a dated table, newest first. */
export function LogSection({index, numbers}: {index: TestingIndex; numbers: Numbered[]}) {
  const names = Object.fromEntries(index.products.map((p) => [p.handle, p.name]));
  return (
    <section className="tr-section" id="log">
      <h2>A Engineering log</h2>
      <p>Each step: what was tested, what was seen, what changed.</p>
      <table className="tr-log">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Tested</th>
            <th scope="col">Saw</th>
            <th scope="col">Changed</th>
          </tr>
        </thead>
        <tbody>
          {index.log.map((e) => {
            const fig = e.figureId ? figureLabel(numbers, index, e.figureId) : null;
            return (
              <tr key={e.id} id={`log-${e.id}`}>
                <td>
                  <time dateTime={e.date}>{e.date}</time>
                  <br />
                  {names[e.product] ?? e.product}
                  {fig && e.figureId ? (
                    <>
                      <br />
                      <a href={`#${anchorFor(index, e.figureId)}`}>{fig}</a>
                    </>
                  ) : null}
                </td>
                <td>{e.tested}</td>
                <td>{e.saw}</td>
                <td>{e.changed ?? 'No change.'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
