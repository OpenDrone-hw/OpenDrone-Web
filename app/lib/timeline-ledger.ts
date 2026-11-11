/**
 * The machine half of /timeline: dated, receipted events GitHub can prove
 * (releases, repos appearing, status-topic flips), appended daily by
 * .github/workflows/timeline-ledger.yml to timeline-ledger.json on this
 * repo's unprotected `data` branch. Read here at request time so a tag cut
 * on a board shows up without a PR, a merge or a deploy. Words are copy
 * templates in content/copy/timeline.json; the ledger carries only facts.
 */
import {ROADMAP} from '~/lib/roadmap-data';

export const LEDGER_URL =
  'https://raw.githubusercontent.com/OpenDrone-hw/OpenDrone-Web/refs/heads/data/timeline-ledger.json';

export type LedgerEvent = {
  id: string;
  kind: 'release' | 'repo' | 'status';
  repo: string;
  date: string;
  url?: string;
  tag?: string;
  name?: string | null;
  prerelease?: boolean;
  status?: string;
  from?: string | null;
  archived?: boolean;
  observed?: string;
};

export type Ledger = {
  version: number;
  updatedAt: string | null;
  /** Per repo state kept by the sync; `gone` is the day a repo stopped being public. */
  repos?: Record<string, {gone?: string} | undefined>;
  events: LedgerEvent[];
};

export type TimelineTag = 'esc' | 'fc' | 'rx' | 'frame' | 'company';

/** Product family for a repo: the roadmap link when it has one, else the
 *  repo name's prefix; anything else is company news. */
export function tagForRepo(repo: string): TimelineTag {
  const link = `https://github.com/OpenDrone-hw/${repo}`.toLowerCase();
  const item = ROADMAP.find((r) => r.link?.toLowerCase() === link);
  const id = item?.id ?? repo.toLowerCase();
  if (id.includes('esc')) return 'esc';
  if (id.includes('fc')) return 'fc';
  if (id.includes('rx')) return 'rx';
  if (id.includes('frame')) return 'frame';
  return 'company';
}

// One in-flight fetch and a 10 minute memory per isolate, the same shape
// as the status-topic fetch: raw.githubusercontent is quick but a busy page
// must never fan out.
let cache: {at: number; ledger: Ledger | null} | null = null;
let inflight: Promise<Ledger | null> | null = null;
const TTL = 600_000;

export async function fetchTimelineLedger(): Promise<Ledger | null> {
  if (cache && Date.now() - cache.at < TTL) return cache.ledger;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(LEDGER_URL, {
        signal: AbortSignal.timeout(4000),
        ...({cf: {cacheTtl: 600, cacheEverything: true}} as RequestInit),
      });
      if (!res.ok) throw new Error(String(res.status));
      const ledger = (await res.json()) as Ledger;
      if (!Array.isArray(ledger?.events)) throw new Error('bad ledger');
      cache = {at: Date.now(), ledger};
      return ledger;
    } catch (err) {
      console.warn('[timeline] ledger fetch failed', err);
      // Remember the miss briefly too, so a broken branch cannot poll.
      cache = {at: Date.now(), ledger: cache?.ledger ?? null};
      return cache.ledger;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
