/**
 * Incutec's financial goals, read from `content/goals.json`.
 *
 * The file is the studio's to write (Goals tab) and git's to version. The
 * progress figure moves one of two ways, per goal:
 *
 * - `mode: "auto"`: `npm run goals:update` (scripts/update-goals.mjs, run
 *   locally by a maintainer) sums Shopify order totals since
 *   the goal opened, applies `allocation_pct`, divides by `target_eur` and
 *   ROUNDS TO 5% STEPS. Deliberately coarse: the public meter stays an
 *   approximation and never resolves to an exact revenue figure. The write
 *   still lands in git for review, and the studio can correct it.
 * - `mode: "manual"`: the studio slider is the only writer.
 *
 * Statuses: `done` goals are kept as a record, `current` is the one being
 * saved for (the cart meter shows the first current goal), `next` is queued.
 */

export type GoalStatus = 'done' | 'current' | 'next';
export type GoalMode = 'auto' | 'manual';

export type Goal = {
  id: string;
  status: GoalStatus;
  /** Short name: "A pick and place machine". */
  title: string;
  /** One paragraph on what reaching it unlocks. */
  body: string;
  /** Approximate target, as prose: "about €30k". Never an invoice figure. */
  target_label: string;
  /** 0-100, clamped on read. Hand-set in manual mode, computed in auto. */
  progress_pct: number;
  /** Who moves the meter. Defaults to manual. */
  mode: GoalMode;
  /** Auto mode: the real target the computation divides by. Never displayed. */
  target_eur: number | null;
  /** Auto mode: percent of gross order value that counts toward the goal. */
  allocation_pct: number;
  /** Auto mode: ISO date the goal opened; orders before it do not count. */
  since: string;
};

const STATUSES: ReadonlySet<string> = new Set(['done', 'current', 'next']);

/** The display granularity of an auto-updated meter. */
export const AUTO_PCT_STEP = 5;

/**
 * Gross euros since `since` -> displayed percent. The 5% floor-rounding is
 * the vagueness guarantee: a reader learns "somewhere in this 5% band of an
 * 'about €30k' target", nothing sharper. Kept here so the unit test and the
 * update script (which restates it, see scripts/update-goals.mjs) cannot
 * drift unnoticed.
 */
export function computeAutoPct(grossEur: number, goal: Goal): number | null {
  if (goal.mode !== 'auto' || !goal.target_eur || goal.target_eur <= 0) {
    return null;
  }
  const counted = Math.max(0, grossEur) * (goal.allocation_pct / 100);
  const raw = (counted / goal.target_eur) * 100;
  return Math.min(100, Math.floor(raw / AUTO_PCT_STEP) * AUTO_PCT_STEP);
}

// Same guarded-glob pattern as app/lib/copy.ts: bundled for the worker,
// HMR-tracked for the studio, absent under node:test.
const FILES = import.meta.env
  ? import.meta.glob<{default: {goals?: unknown}}>('/content/goals.json', {
      eager: true,
    })
  : {};

/** Clamp one raw record into a Goal, or null if it is not one. */
export function normalizeGoal(raw: unknown): Goal | null {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw as Record<string, unknown>;
  if (typeof g.id !== 'string' || !g.id) return null;
  const pct = typeof g.progress_pct === 'number' ? g.progress_pct : 0;
  const alloc =
    typeof g.allocation_pct === 'number' ? g.allocation_pct : 100;
  return {
    id: g.id,
    status: STATUSES.has(g.status as string) ? (g.status as GoalStatus) : 'next',
    title: typeof g.title === 'string' ? g.title : '',
    body: typeof g.body === 'string' ? g.body : '',
    target_label: typeof g.target_label === 'string' ? g.target_label : '',
    progress_pct: Math.min(100, Math.max(0, Math.round(pct))),
    mode: g.mode === 'auto' ? 'auto' : 'manual',
    target_eur:
      typeof g.target_eur === 'number' && g.target_eur > 0 ? g.target_eur : null,
    allocation_pct: Math.min(100, Math.max(0, alloc)),
    since: typeof g.since === 'string' ? g.since : '',
  };
}

export function goals(): Goal[] {
  const mod = Object.values(FILES)[0];
  const list = mod?.default?.goals;
  if (!Array.isArray(list)) return [];
  return list
    .map(normalizeGoal)
    .filter((g): g is Goal => g !== null);
}

/** The goal the cart meter points at. First `current` in file order. */
export function currentGoal(): Goal | undefined {
  return goals().find((g) => g.status === 'current');
}
