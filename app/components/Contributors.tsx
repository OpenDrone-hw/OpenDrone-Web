import type {Contributor} from '~/lib/github';
import {contributorColor} from '~/lib/contributor-colors';
import {DISCORD_INVITE_URL} from '~/lib/company';
import {Txt} from './Txt';
import {copyText} from '~/lib/copy';

/**
 * Contributor grid for the PDP "Built in the open" chapter: one tile per
 * GitHub account with commits on the product's repos, plus a standing
 * "+ you" tile. The tile points at Discord, not the issue tracker: the
 * contributing flow is talk-first (find the maintainer, agree on the change,
 * then touch files), so the invitation must not skip that step. The section
 * renders even when the GitHub API is rate-limited (empty list): the
 * invitation tile is the point, the avatars are the proof.
 *
 * No commit counts. A count reads as a ranking and gets the credit backwards:
 * on OpenRX it put 153 doc and scaffolding commits ahead of the 8 that are
 * the boards. Order comes from `credits` in the product's content JSON where
 * it is set (see orderByCredits in app/lib/contributors-snapshot.ts), and the
 * first name there is the maintainer, marked as such on their tile.
 */
export function ContributorGrid({
  contributors,
  lead,
}: {
  contributors: Contributor[];
  /** GitHub login of the product's maintainer; their tile carries the mark. */
  lead?: string;
}) {
  return (
    <ul className="contributor-grid">
      {contributors.map((c) => (
        <li key={c.login}>
          <a
            className={`contributor-tile${
              c.login === lead ? ' contributor-tile--lead' : ''
            }`}
            href={c.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            // The tile's accent doubles as the legend for the commit strip:
            // same login-hashed color on both (app/lib/contributor-colors.ts).
            style={
              {'--contrib-accent': contributorColor(c.login)} as React.CSSProperties
            }
          >
            {/* NOT loading="lazy". The chapter sets content-visibility: auto,
                so this subtree is size-contained until it nears the viewport,
                and a lazy image inside it reads as far offscreen and never
                gets fetched - the avatars stayed blank even once the grid was
                on screen. content-visibility already does the deferring; a
                60px avatar needs no second mechanism. */}
            <img
              className="contributor-avatar"
              src={`${c.avatarUrl}${c.avatarUrl.includes('?') ? '&' : '?'}s=120`}
              alt=""
              width={60}
              height={60}
              decoding="async"
            />
            <span className="contributor-login">{c.login}</span>
            {c.login === lead ? (
              <span className="contributor-role">
                {copyText('product-chrome.contributor_maintainer')}
              </span>
            ) : null}
          </a>
        </li>
      ))}
      <li>
        <a
          className="contributor-tile contributor-tile--you"
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span className="contributor-avatar contributor-avatar--you" aria-hidden="true">
            +
          </span>
          <Txt
            id="product-chrome.contributor_you"
            as="span"
            className="contributor-login"
          />
          <Txt
            id="product-chrome.contributor_you_cta"
            as="span"
            className="contributor-count"
          />
        </a>
      </li>
    </ul>
  );
}

/** Loading placeholder: same grid, grey tiles, no text. */
export function ContributorGridSkeleton() {
  return (
    <ul className="contributor-grid" aria-hidden="true">
      {Array.from({length: 4}, (_, i) => (
        <li key={i}>
          <span className="contributor-tile is-skeleton">
            <span className="contributor-avatar" />
            <span className="contributor-login">&nbsp;</span>
            <span className="contributor-count">&nbsp;</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
