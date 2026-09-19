import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/learn.$slug';
import {buildSeoMeta} from '~/lib/seo';
import {
  claimCount,
  dossierMeta,
  isCircular,
  learnDraftEnabled,
  loadDossierSource,
  parseDossier,
  sourceLabel,
  type Block,
  type Claim,
  type Confidence,
} from '~/lib/learn';

/**
 * /learn/<slug> - one research dossier, rendered claim by claim.
 *
 * The point of this rendering is reviewability: the claim, its confidence tag
 * and every source it cites are all on screen together. A claim with no source
 * is called out rather than quietly styled the same as a cited one.
 */

export const meta: Route.MetaFunction = ({data}) =>
  buildSeoMeta({
    title: data?.dossier ? `${data.dossier.title} - draft` : 'Learn - draft',
    description: 'FPV research notes, unpublished.',
    robots: 'noindex, nofollow',
  });

export async function loader({context, params}: Route.LoaderArgs) {
  if (!learnDraftEnabled(context.env)) {
    throw new Response('Not Found', {status: 404});
  }
  const slug = params.slug ?? '';
  const meta = dossierMeta(slug);
  const src = await loadDossierSource(slug);
  if (!meta || !src) {
    throw new Response('Not Found', {status: 404});
  }
  return {dossier: parseDossier(slug, src), meta};
}

/**
 * The corpus leans hard on `inline code` for file paths, defines and register
 * names, and a claim reads badly with literal backticks in it. Rendered by
 * splitting on backtick pairs into React nodes rather than by building an HTML
 * string: there is no `dangerouslySetInnerHTML` on this page, so a claim can
 * never inject markup no matter what a future dossier contains.
 */
function inlineCode(text: string): React.ReactNode[] {
  return text.split(/`([^`]+)`/).map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : part,
  );
}

function BlockItem({block}: {block: Block}) {
  if (block.kind === 'prose') {
    return <p className="learn-prose">{inlineCode(block.text)}</p>;
  }
  return (
    <div className="learn-table-wrap">
      <table className="learn-table">
        <thead>
          <tr>
            {block.head.map((c, i) => (
              <th key={i}>{inlineCode(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r}>
              {row.map((c, i) => (
                <td key={i}>{inlineCode(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const CONFIDENCE_TITLE: Record<Confidence, string> = {
  verified: 'Two independent sources, or one primary source',
  single: 'One secondary source only, needs corroboration',
  lore: 'Widely repeated in the community, not documented',
  untagged: 'No confidence tag on this line',
};

function ClaimItem({claim}: {claim: Claim}) {
  const circular = isCircular(claim);
  return (
    <li className="learn-claim" id={claim.id}>
      <p className="learn-claim-text">{inlineCode(claim.text)}</p>
      <p className="learn-claim-meta">
        <span
          className={`learn-tag learn-tag-${claim.confidence}`}
          title={CONFIDENCE_TITLE[claim.confidence]}
        >
          {claim.confidence}
          {claim.note ? ` · ${claim.note}` : ''}
        </span>
        {claim.sources.map((url) => (
          <a
            key={url}
            className="learn-source"
            href={url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {sourceLabel(url)}
          </a>
        ))}
        {circular ? (
          <span
            className="learn-tag learn-tag-circular"
            title="Cites OpenBrain's own fact pool, so it cannot be fed back into it"
          >
            circular
          </span>
        ) : null}
        {!claim.sources.length && !circular ? (
          <span className="learn-source learn-source-none">no link</span>
        ) : null}
      </p>
    </li>
  );
}

export default function LearnDossier() {
  const {dossier, meta} = useLoaderData<typeof loader>();
  const total = claimCount(dossier);
  const withSource = dossier.sections.reduce(
    (n, s) => n + s.claims.filter((c) => c.sources.length > 0).length,
    0,
  );
  const headings = dossier.sections.filter((s) => s.level === 2);

  return (
    <article className="page-shell learn-page">
      <div className="reading-column">
        <div className="policy-back-link">
          <Link prefetch="intent" to="/learn">
            All research
          </Link>
        </div>

        <header className="page-header">
          <p className="page-eyebrow">Learn, draft</p>
          <h1 className="page-title">{meta.title}</h1>
        </header>

        <dl className="learn-stats">
          <div>
            <dt>Claims</dt>
            <dd>{total}</dd>
          </div>
          <div>
            <dt>Verified</dt>
            <dd>{dossier.counts.verified}</dd>
          </div>
          <div>
            <dt>Single source</dt>
            <dd>{dossier.counts.single}</dd>
          </div>
          <div>
            <dt>Linked</dt>
            <dd>
              {withSource} of {total}
            </dd>
          </div>
        </dl>

        <p className="learn-draft-notice" role="note">
          <strong>Draft, unreviewed.</strong> {meta.blurb} Feeds {meta.feeds}.
        </p>

        {dossier.intro.length ? (
          <div className="rich-content learn-intro">
            {dossier.intro.map((p, i) => (
              <p key={i}>{inlineCode(p)}</p>
            ))}
          </div>
        ) : null}

        {headings.length > 2 ? (
          <nav className="learn-toc" aria-label="Sections">
            <ul>
              {headings.map((s) => (
                <li key={s.id}>
                  <a href={`#${s.id}`}>{s.heading}</a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}

        {dossier.sections.map((s) => (
          <section key={s.id} id={s.id} className="learn-section">
            {s.level === 2 ? (
              <h2>{s.heading}</h2>
            ) : s.level === 3 ? (
              <h3>{s.heading}</h3>
            ) : (
              <h4>{s.heading}</h4>
            )}
            {s.blocks.map((b, i) => (
              <BlockItem key={i} block={b} />
            ))}
            {s.claims.length ? (
              <ul className="learn-claims">
                {s.claims.map((c) => (
                  <ClaimItem key={c.id} claim={c} />
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
    </article>
  );
}
