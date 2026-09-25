import type {Route} from './+types/roadmap';
import {Fragment} from 'react';
import {Link} from 'react-router';
import {buildSeoMeta} from '~/lib/seo';
import {EditorialShell, SeriesRail} from '~/components/EditorialShell';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';
import {DISCORD_INVITE_URL, CONTRIBUTING_URL} from '~/lib/company';
import {
  STATUS_ORDER,
  fetchStatusFlagsFast,
  resolveRoadmap,
  voteCandidates,
  type RoadmapItem,
} from '~/lib/roadmap-data';
import {voteShares, voteTally} from '~/lib/votes';
import {launchedStatusFlags} from '~/lib/launched-roadmap';
import {CAMPAIGN} from '~/lib/catalog-client';
import {comingSoonFlag} from '~/lib/coming-soon';
import {checkoutOpen} from '~/lib/shopify-cart-action';
import {BOARD_ART_VERSION} from '~/data/board-art-version';
import {assetUrl} from '~/lib/asset-url';

// roadmap-data points at /boards/<handle>/front.png (the 1568 px render);
// the kanban card is 10.5rem wide, so serve the WebP thumbnails written next to
// it by scripts/export-board-art.mjs instead.
const boardThumb = (png: string, w: 528 | 800) =>
  assetUrl(
    `${png.replace(/front\.png$/, `front-w${w}.webp`)}${BOARD_ART_VERSION ? `?v=${BOARD_ART_VERSION}` : ''}`,
  );

/**
 * Words live in `content/copy/roadmap.json`; this file holds the machinery.
 *
 * The split is not the usual one here, because this page carries the product
 * status system. A status is a controlled vocabulary shared with the
 * `status-*` topics on the GitHub repos, so the status KEYS and their column
 * order stay in code where a copy edit cannot invent a sixth status or
 * reorder the board. What a status is CALLED, and the sentence explaining it,
 * are prose and live in the copy file, keyed 1:1 off the status key. Same for
 * the roadmap entries: the status, the links and the order are code; the name
 * and the one-line note are copy, keyed off the entry's `id`.
 */
export const meta: Route.MetaFunction = () =>
  buildSeoMeta({
    title:
      copyText('roadmap.meta_title') ??
      'Roadmap · What we build and how to help',
    description: copyText('roadmap.meta_description') ?? '',
  });

// The status-* topic fetch (canonical status carrier) lives in
// app/lib/roadmap-data.ts now, shared with the ballot's candidate route.
// The fast variant caps the wait: static statuses stand in while a cold
// cache warms, instead of the whole page hanging on GitHub.
export async function loader({context}: Route.LoaderArgs) {
  const env = context.env as unknown as Record<string, string | undefined>;
  const flags = await fetchStatusFlagsFast(
    env.GITHUB_STATUS_TOKEN,
    undefined,
    context.waitUntil,
  );
  // Same launched-state overlay as the root loader, so the board and the
  // product pages agree on the boards with a paid first batch.
  const shopOpen = !comingSoonFlag(env) && checkoutOpen(env);
  return {roadmap: resolveRoadmap(launchedStatusFlags(flags, shopOpen, CAMPAIGN))};
}

// ROADMAP, STATUS_ORDER and the vote-candidate rule live in
// `app/lib/roadmap-data.ts` so the cart ballot derives its choices from the
// same structure this board renders. Only the rendering stays here.

/**
 * The community vote, read from `content/votes.json` (written by the tally
 * script, reviewable in the studio's Goals tab).
 *
 * Takes the LIVE roadmap from the loader, so the section keeps itself
 * current: an entry graduating out of `planned`/`in-progress` leaves the
 * standings on its own and moves to the "already moving" receipt below if it
 * had votes, and a newly listed entry appears with its listed-since date so a
 * low count reads as "new", not "unpopular". Each row shows how many ballots
 * ranked it, as the reference figure next to the share bar.
 */
function VotesSection({roadmap}: {roadmap: RoadmapItem[]}) {
  const tally = voteTally();
  const candidates = voteCandidates(roadmap);
  const shares = voteShares(
    tally,
    candidates.map((c) => c.id),
  );
  const rows = [...candidates].sort(
    (a, b) => (tally.points[b.id] ?? 0) - (tally.points[a.id] ?? 0),
  );
  // Voted-for entries that have since left the candidate set: the receipt
  // that voting moves things. Their points stay in the tally on purpose.
  const graduated = roadmap.filter(
    (r) =>
      !candidates.some((c) => c.id === r.id) && (tally.mentions[r.id] ?? 0) > 0,
  );
  const hasVotes = tally.ballots > 0;

  return (
    <section className="editorial-section">
      <Txt id="roadmap.votes_title" as="h2" className="editorial-section-title" />
      <Txt id="roadmap.votes_body" as="p" />
      {hasVotes ? (
        <div className="vote-board">
          {rows.map((c) => (
            <div className="vote-row" key={c.id}>
              <span className="vote-name">
                <Txt id={`roadmap.item_${c.id}_name`} />
                {c.added ? (
                  <span className="vote-added">
                    <Txt id="roadmap.votes_added_prefix" /> {c.added}
                  </span>
                ) : null}
              </span>
              <span className="vote-bar" aria-hidden="true">
                <span
                  className="vote-bar-fill"
                  style={{width: `${shares[c.id]}%`}}
                />
              </span>
              <span className="vote-share">
                {shares[c.id]}%
                <span className="vote-count">
                  {tally.mentions[c.id] ?? 0}{' '}
                  <Txt id="roadmap.votes_count_label" />
                </span>
              </span>
            </div>
          ))}
          <p className="vote-foot">
            {tally.ballots} <Txt id="roadmap.votes_ballots_label" />
            {' · '}
            <Txt id="roadmap.votes_method" />
          </p>
          {graduated.length ? (
            <div className="vote-graduated">
              <Txt id="roadmap.votes_graduated_title" as="p" />
              <ul>
                {graduated.map((r) => (
                  <li key={r.id}>
                    <Txt id={`roadmap.item_${r.id}_name`} />
                    {' · '}
                    <Txt id={`roadmap.status_${r.status}_label`} />
                    {' · '}
                    {tally.mentions[r.id]}{' '}
                    <Txt id="roadmap.votes_count_label" />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <Txt id="roadmap.votes_empty" as="p" className="vote-empty" />
      )}
    </section>
  );
}


export default function RoadmapRoute({loaderData}: Route.ComponentProps) {
  // Board reads top-to-bottom as the product's LIFE reads: planned first,
  // launched last. Products flow DOWN the page through the gates.
  const columns = [...STATUS_ORDER].reverse().map((status) => ({
    status,
    items: loaderData.roadmap.filter((r) => r.status === status),
  }));

  // The community vote, ON the board: votable cards carry their share bar
  // so the standings live where the projects do. (Same tally the section
  // below explains; empty tally shows nothing.)
  const tally = voteTally();
  const voteCandidateIds = voteCandidates(loaderData.roadmap).map((c) => c.id);
  const shares = voteShares(tally, voteCandidateIds);

  return (
    <>
      {/* The board is a full-width band ABOVE the editorial shell: inside
          the prose measure it could never show all five stages at once and
          clipped with an invisible scrollbar on 16:9 screens. Out here it
          gets the full shared rail (up to 1440px) and the whole pipeline
          fits on a desktop viewport. */}
      <div className="kanban-band">
      <SeriesRail slug="roadmap" />
      <header className="editorial-hero kanban-hero">
        <Txt id="roadmap.title" as="h1" className="editorial-title" />
        <Txt id="roadmap.lead" as="p" className="editorial-lead kanban-intro" />
      </header>

      <section className="editorial-section kanban-lead">
        <div className="kanban">
          {columns.map((col) => (
            <Fragment key={col.status}>
            {/* The gate INTO this stage sits above it: the curved arrow
                descends into the row below and names what a design must
                earn to pass. The first gate (above planned) is the door
                onto the board itself. */}
            <div className="kanban-gate">
              <svg
                className="kanban-gate-arrow"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M21 3 C11 3 7 8 7 17" fill="none" />
                <path d="M3.5 14 L7 19 L10.5 14" fill="none" />
              </svg>
              <Txt
                id={`roadmap.gate_${col.status}`}
                as="span"
                className="kanban-gate-label"
              />
            </div>
            <section className="kanban-row" data-status={col.status}>
              <h2 className="kanban-col-head" data-status={col.status}>
                <span className="kanban-dot" />
                <Txt id={`roadmap.status_${col.status}_label`} />
                <span className="kanban-count">
                  {/* Boards, not entries: OpenRX is one entry, four boards. */}
                  {col.items.reduce((n, r) => n + (r.variants?.length ?? 1), 0)}
                </span>
              </h2>
              {/* The stage explains itself: same copy the legend chapter
                  used to hold, now inline where the reader actually is. */}
              <Txt
                id={`roadmap.status_${col.status}_legend`}
                as="p"
                className="kanban-stage-note"
              />
              <div className="kanban-row-cards">
              {col.items.length === 0 ? (
                <Txt id="roadmap.kanban_empty" as="p" className="kanban-empty" />
              ) : (
                col.items.flatMap((r) => {
                  // One card per BOARD: an entry with variants (OpenRX) fans
                  // out, everything else is its own card. Visual first: the
                  // render is the card, the name is the caption, and the whole
                  // card is the link. From alpha on there is a product page
                  // worth landing on; before that the design source is the
                  // truth, so the card goes to GitHub.
                  const toProduct =
                    STATUS_ORDER.indexOf(r.status) <=
                      STATUS_ORDER.indexOf('alpha') && r.productPath;
                  const cards = r.variants ?? [{id: r.id, image: r.image}];
                  return cards.map((card) => {
                    const body = (
                      <>
                        {card.image ? (
                          <span className="kanban-media">
                            <img
                              src={boardThumb(card.image, 800)}
                              srcSet={`${boardThumb(card.image, 528)} 528w, ${boardThumb(card.image, 800)} 800w`}
                              sizes="150px"
                              alt=""
                              loading="lazy"
                              decoding="async"
                            />
                          </span>
                        ) : null}
                        <Txt
                          id={`roadmap.item_${card.id}_name`}
                          as="h3"
                          className="kanban-name"
                        />
                        {tally.ballots > 0 &&
                        voteCandidateIds.includes(r.id) &&
                        (tally.mentions[r.id] ?? 0) > 0 ? (
                          <span className="kanban-vote">
                            <span className="kanban-vote-bar" aria-hidden="true">
                              <span
                                className="kanban-vote-fill"
                                style={{width: `${shares[r.id] ?? 0}%`}}
                              />
                            </span>
                            {shares[r.id] ?? 0}%
                          </span>
                        ) : null}
                      </>
                    );
                    if (toProduct) {
                      return (
                        <Link
                          prefetch="viewport"
                          to={r.productPath as string}
                          className="kanban-card is-linked"
                          key={card.id}
                        >
                          {body}
                        </Link>
                      );
                    }
                    if (r.link) {
                      return (
                        <a
                          href={r.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="kanban-card is-linked"
                          key={card.id}
                        >
                          {body}
                        </a>
                      );
                    }
                    return (
                      <article className="kanban-card" key={card.id}>
                        {body}
                      </article>
                    );
                  });
                })
              )}
              </div>
            </section>
            </Fragment>
          ))}
        </div>
      </section>
      </div>

    <EditorialShell slug="roadmap" rail={false}>
      <section className="editorial-section">
        <Txt id="roadmap.s1_title" as="h2" className="editorial-section-title" />
        <Txt id="roadmap.s1_body" as="p" />
      </section>

      <VotesSection roadmap={loaderData.roadmap} />

      {/* The how-to-contribute sections moved to /contributing (2026-08-11);
          the roadmap is the status board, votes and goals. */}
      {/* Not the Discord+GitHub pair: that is /contributing's closing move,
          and the two pages sit next to each other in the series (audit
          2026-08-12). The roadmap hands off to the manual instead. */}
      <section className="editorial-cta">
        <a
          href={CONTRIBUTING_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="editorial-cta-primary"
        >
          <Txt id="roadmap.cta_primary" />
        </a>
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="editorial-cta-secondary"
        >
          <Txt id="roadmap.cta_secondary" />
        </a>
      </section>
    </EditorialShell>
    </>
  );
}
