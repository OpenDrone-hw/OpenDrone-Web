import type {Fig, TestingIndex} from '~/lib/testing/types';
import {runReduction, type Numbered} from '~/lib/testing/layout';
import {caveatRunWide, caveatText} from '~/lib/testing/types';
import {Figure} from './Figure';
import {runState} from './TitleBlock';

/**
 * One numbered section of the report: its heading, a header line (setup, runs,
 * status, what is not measured), the setup of each run stated once, the run's
 * photo if it has one, then its figures in order, each with its findings.
 */
export function ProductSection({
  product,
  section,
  index,
  previews,
  numbers,
  photoNo,
}: {
  product: TestingIndex['products'][number];
  section: number;
  index: TestingIndex;
  previews: Record<string, Fig>;
  numbers: Numbered[];
  /** Number of the section's run photo in the document. */
  photoNo?: number;
}) {
  const mine = numbers.filter((n) => product.figures.includes(n.id));
  const runIds = [...new Set(mine.map((n) => index.figures[n.id]!.runId))];
  const cov = product.coverage;
  // The draft status is printed once on the title block; a section names it only when the runs differ.
  const states = new Set(Object.values(index.runs).map((r) => runState(r.setup)).filter(Boolean));
  const state = states.size > 1 ? (runIds.map((r) => runState(index.runs[r]?.setup ?? [])).find(Boolean) ?? null) : null;
  // Notes about a whole run, stated once under its setup.
  const limits = (rid: string): string[] => {
    const out: string[] = [];
    for (const n of mine) {
      if (index.figures[n.id]!.runId !== rid) continue;
      for (const c of previews[n.id]?.caveats ?? []) if (caveatRunWide(c) && !out.includes(caveatText(c))) out.push(caveatText(c));
    }
    return out;
  };
  const photo = runIds.map((r) => index.runs[r]?.photo).find(Boolean);
  // The newest step of the log that changed something and has no figure of its own to say so under.
  const loose = index.log.find((e) => e.product === product.handle && e.changed && !e.figureId);
  return (
    <section className="tr-section" id={product.handle}>
      <h2>
        {section} {product.name}
      </h2>
      <p className="tr-head">
        {runIds.map((rid) => (
          <span key={rid}>
            <b>Run</b> {rid.replace(/-\d{4}-\d{2}-\d{2}$/, '')}, {index.runs[rid]?.date}
          </span>
        ))}
        {state ? (
          <span>
            <b>Status</b> {state}
          </span>
        ) : null}
        {loose ? (
          <span>
            <b>Last change</b> {loose.date}, <a href={`#log-${loose.id}`}>see the log</a>
          </span>
        ) : null}
      </p>
      {runIds.map((rid, ri) => {
        const run = index.runs[rid];
        if (!run) return null;
        const lines = run.setup.filter((l) => !/^Run state:/.test(l));
        const mineOfRun = mine.filter((n) => index.figures[n.id]!.runId === rid);
        const reduction = runReduction(mineOfRun.map((n) => ({no: n.no, reduction: previews[n.id]?.reduction})));
        const gaps = ri === runIds.length - 1 ? (cov?.gaps ?? []).map((g) => g.toLowerCase()) : [];
        const lim = limits(rid);
        const showPhoto = photo && index.runs[rid]?.photo === photo;
        return (
          <div key={rid}>
            {runIds.length > 1 ? (
              <p className="tr-runline">
                Run {rid.replace(/-\d{4}-\d{2}-\d{2}$/, '')}, {run.date}
              </p>
            ) : null}
            <div className="tr-runblock" data-photo={showPhoto ? '1' : undefined}>
              <div className="tr-runtext">
                <h3 className="tr-label">Setup</h3>
                {run.table?.length ? (
                  <table className="tr-kv" aria-label={`Setup of run ${rid}`}>
                    <tbody>
                      {run.table.map(([k, v]) => (
                        <tr key={k}>
                          <th scope="row">{k}</th>
                          <td>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <ul className="tr-lim" aria-label={`Setup of run ${rid}`}>
                    {lines.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                )}
              </div>
              {showPhoto ? (
                <figure className="tr-photo">
                  <img src={photo.src} width={photo.size[0]} height={photo.size[1]} alt={photo.alt} loading="lazy" decoding="async" />
                  <figcaption>
                    <b>Photo {photoNo ?? 1}.</b> {photo.caption}
                  </figcaption>
                </figure>
              ) : null}
            </div>
            {lim.length || gaps.length ? (
              <>
                <h3 className="tr-label">Limits</h3>
                <ul className="tr-lim">
                  {lim.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                  {gaps.length ? <li>Not measured: {gaps.join(', ')}.</li> : null}
                </ul>
              </>
            ) : null}
            {reduction ? (
              <>
                <h3 className="tr-label">Reduction</h3>
                <p className="tr-red">{reduction}</p>
              </>
            ) : null}
          </div>
        );
      })}
      {mine.map((n) => (
        <Figure
          key={n.id}
          id={n.id}
          no={n.no}
          summary={index.figures[n.id]!}
          run={index.runs[index.figures[n.id]!.runId]}
          preview={previews[n.id]!}
        />
      ))}
    </section>
  );
}
