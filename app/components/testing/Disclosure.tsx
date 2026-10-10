import {caveatFlagged, caveatText, type Caveat} from '~/lib/testing/types';

/**
 * "Setup and caveats (n)". Open from the start when a caveat is flagged. The
 * flagged ones are listed first and the rest sit one fold down, so an open
 * disclosure stays short.
 */
export function Disclosure({
  caveats,
  setup,
  reduction,
  cite,
}: {
  caveats: Caveat[];
  setup: string[];
  reduction?: string;
  cite?: string;
}) {
  const flagged = caveats.filter(caveatFlagged);
  const rest = caveats.filter((c) => !caveatFlagged(c));
  return (
    <details className="tw-details" open={flagged.length > 0 || undefined}>
      <summary>Setup and caveats ({caveats.length})</summary>
      <div className="tw-details-body">
        {flagged.length > 0 ? (
          <ul className="tw-flagged">
            {flagged.map((c) => (
              <li key={caveatText(c)}>{caveatText(c)}</li>
            ))}
          </ul>
        ) : null}
        <details className="tw-more" open={flagged.length === 0 || undefined}>
          <summary>{flagged.length ? 'More' : 'Details'}</summary>
          <h4>Setup</h4>
          <ul>
            {setup.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          {rest.length ? (
            <>
              <h4>Caveats</h4>
              <ul>
                {rest.map((c) => (
                  <li key={caveatText(c)}>{caveatText(c)}</li>
                ))}
              </ul>
            </>
          ) : null}
          {reduction ? (
            <>
              <h4>Reduction</h4>
              <p>{reduction}</p>
            </>
          ) : null}
          {cite ? (
            <>
              <h4>Source</h4>
              <p className="tw-cite">{cite}</p>
            </>
          ) : null}
        </details>
      </div>
    </details>
  );
}
