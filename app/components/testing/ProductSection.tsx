import type {Fig, TestingIndex} from '~/lib/testing/types';
import type {Numbered} from '~/lib/testing/layout';
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
}: {
  product: TestingIndex['products'][number];
  section: number;
  index: TestingIndex;
  previews: Record<string, Fig>;
  numbers: Numbered[];
}) {
  const mine = numbers.filter((n) => product.figures.includes(n.id));
  const runIds = [...new Set(mine.map((n) => index.figures[n.id]!.runId))];
  const cov = product.coverage;
  const state = runIds.map((r) => runState(index.runs[r]?.setup ?? [])).find(Boolean) ?? null;
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
            <b>Setup</b> {index.runs[rid]?.chip}
          </span>
        ))}
        {runIds.map((rid) => (
          <span key={`${rid}-run`}>
            <b>Run</b> <code>{rid.replace(/-\d{4}-\d{2}-\d{2}$/, '')}</code> {index.runs[rid]?.date}
          </span>
        ))}
        {state ? (
          <span>
            <b>Status</b> {state}
          </span>
        ) : null}
        {cov?.gaps?.length ? (
          <span>
            <b>Not measured</b> {cov.gaps.map((g) => g.toLowerCase()).join(', ')}
          </span>
        ) : null}
        {loose ? (
          <span>
            <b>Last change</b> {loose.date}, <a href={`#log-${loose.id}`}>see the log</a>
          </span>
        ) : null}
      </p>
      {photo ? (
        <figure className="tr-photo">
          <img src={photo.src} width={photo.size[0]} height={photo.size[1]} alt={photo.alt} loading="lazy" decoding="async" />
          <figcaption>{photo.caption}</figcaption>
        </figure>
      ) : null}
      <h3>Setup</h3>
      {runIds.map((rid) => {
        const run = index.runs[rid];
        if (!run) return null;
        const lines = run.setup.filter((l) => !/^Run state:/.test(l));
        return (
          <div key={rid}>
            {runIds.length > 1 ? (
              <p className="tr-runline">
                Run <code>{rid.replace(/-\d{4}-\d{2}-\d{2}$/, '')}</code> {run.date}
              </p>
            ) : null}
            <ul className="tr-setup" aria-label={`Setup of run ${rid}`}>
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
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
          hint={n.no === 1}
        />
      ))}
    </section>
  );
}
