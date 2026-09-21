/**
 * The community vote: the read side of the tally store.
 *
 * The ballot used to ride on a Shopify cart attribute (`_vote_rank`),
 * which checkout copied onto the order for a nightly tally script. The
 * ballot and its codec are gone; what stays is the display, reading
 * `content/votes.json` exactly as before. There is no live ballot and no
 * write path here (Upstash Redis was removed entirely, founder decision,
 * 2026-09-15); until one exists the file no longer changes and /roadmap
 * shows its empty state.
 *
 * The tally file is committed like all other content, so the counts shown
 * on /roadmap are exactly as fresh as the last tally, and the maintainer
 * can review or correct them in the studio's Goals tab.
 */

/** Shape of `content/votes.json`. */
export type VoteTally = {
  /** ISO date of the last tally run, or "" before the first one. */
  updated: string;
  /** Ballots counted. */
  ballots: number;
  /** Weighted points per roadmap id (3/2/1 by rank). */
  points: Record<string, number>;
  /** Ballots that ranked each id anywhere: the human-readable count. */
  mentions: Record<string, number>;
};

const EMPTY: VoteTally = {updated: '', ballots: 0, points: {}, mentions: {}};

// Same guarded-glob pattern as app/lib/copy.ts: bundled for the worker,
// HMR-tracked for the studio, absent under node:test.
const FILES = import.meta.env
  ? import.meta.glob<{default: VoteTally}>('/content/votes.json', {eager: true})
  : {};

export function voteTally(): VoteTally {
  const mod = Object.values(FILES)[0];
  const t = mod?.default;
  if (!t || typeof t !== 'object') return EMPTY;
  return {
    updated: typeof t.updated === 'string' ? t.updated : '',
    ballots: Number.isFinite(t.ballots) ? Math.max(0, Math.floor(t.ballots)) : 0,
    points: t.points && typeof t.points === 'object' ? t.points : {},
    mentions: t.mentions && typeof t.mentions === 'object' ? t.mentions : {},
  };
}

/**
 * Percentage share per candidate, over the given ids. Sums can exceed 100 by
 * a point from rounding; the bars are visual, not an audit, and each value is
 * rounded for display anyway.
 */
export function voteShares(
  tally: VoteTally,
  ids: readonly string[],
): Record<string, number> {
  const total = ids.reduce((sum, id) => sum + (tally.points[id] ?? 0), 0);
  const out: Record<string, number> = {};
  for (const id of ids) {
    out[id] = total > 0 ? Math.round(((tally.points[id] ?? 0) / total) * 100) : 0;
  }
  return out;
}
