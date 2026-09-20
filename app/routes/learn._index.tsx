import {Link, useLoaderData} from 'react-router';
import type {Route} from './+types/learn._index';
import {buildSeoMeta} from '~/lib/seo';
import {LEARN_DOSSIERS, learnDraftEnabled} from '~/lib/learn';

/**
 * /learn - index of the FPV knowledge layer.
 *
 * Draft-gated and noindex: the material below is research, not published copy.
 * See `app/lib/learn.ts` for why, and `drafts/learn/PLAN.md` for the chapter
 * map it is being written into.
 */

export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title: 'Learn - draft',
    description: 'FPV research notes, unpublished.',
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
          <p className="page-eyebrow">Learn</p>
          <h1 className="page-title">The FPV Field Guide</h1>
        </header>

        <div className="rich-content">
          <p className="learn-draft-notice" role="note">
            <strong>Draft, unreviewed.</strong> What follows is the research
            layer, not the guide. Every claim is one bullet carrying its own
            sources and a confidence tag, so it can be checked line by line.
            None of it has been through the fact-check pass yet, and none of it
            is written in the engineer-to-consumer voice the chapters will use.
            This page exists to be read and argued with.
          </p>
          <p>
            The plan is a layered explanation of the whole FPV stack, built on
            one spine: a drone is a stack of nested control loops, each faster
            than the one around it, and every component exists to serve one
            loop. Most myths come from not knowing which loop a spec lives in.
          </p>
        </div>

        <ul className="learn-index">
          {dossiers.map((d) => (
            <li key={d.slug} className="learn-index-item">
              <Link prefetch="intent" to={`/learn/${d.slug}`}>
                <h2>{d.title}</h2>
              </Link>
              <p>{d.blurb}</p>
              <p className="learn-feeds">Feeds {d.feeds}</p>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
