import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/learn._index';
import {buildSeoMeta} from '~/lib/seo';
import {LEARN_DOSSIERS, learnDraftEnabled} from '~/lib/learn';
import {Txt} from '~/components/Txt';
import {copyFill, copyText} from '~/lib/copy';

/**
 * /learn - index of the FPV knowledge layer.
 *
 * Draft-gated and noindex: the material below is research, not published copy.
 * See `app/lib/learn.ts` for why, and `drafts/learn/PLAN.md` for the chapter
 * map it is being written into.
 */

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: copyText('learn.meta_title') ?? 'Learn - draft',
    description: copyText('learn.meta_description') ?? 'FPV research notes, unpublished.',
    robots: 'noindex, nofollow',
  });

export async function loader({context}: Route.LoaderArgs) {
  if (!learnDraftEnabled(context.env)) {
    throw new Response('Not Found', {status: 404});
  }
  return {dossiers: LEARN_DOSSIERS};
}

export default function LearnIndex() {
  const {dossiers} = useLoaderData<typeof loader>();
  return (
    <article className="page-shell learn-page">
      <div className="reading-column">
        <header className="page-header">
          <Txt id="learn.index_eyebrow" as="p" className="page-eyebrow" fallback="Learn" />
          <Txt
            id="learn.index_title"
            as="h1"
            className="page-title"
            fallback="The FPV Field Guide"
          />
        </header>

        <div className="rich-content">
          <Txt
            id="learn.index_notice"
            as="p"
            className="learn-draft-notice"
            role="note"
          />
          <Txt id="learn.index_plan" as="p" />
        </div>

        <ul className="learn-index">
          {dossiers.map((d) => (
            <li key={d.slug} className="learn-index-item">
              <Link prefetch="intent" to={`/learn/${d.slug}`}>
                <h2>{d.title}</h2>
              </Link>
              <p>{d.blurb}</p>
              <p className="learn-feeds">
                {copyFill('learn.feeds', 'Feeds {feeds}', {feeds: d.feeds})}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
