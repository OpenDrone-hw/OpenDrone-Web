/**
 * Which ledger events /timeline shows. The ledger only ever grows, so a repo
 * that was public once (and got a "repo" or "release" event) can later be
 * made private, renamed or deleted: its links then answer 404. The daily
 * sync marks such a repo `gone` in the ledger's `repos` map
 * (scripts/sync-timeline.mjs) and the page drops its events.
 *
 * Bundler-free so the node:test suite can load it.
 */
export type LedgerRepos = Record<string, {gone?: string} | undefined>;

export function liveLedgerEvents<E extends {repo: string}>(
  ledger: {events: E[]; repos?: LedgerRepos} | null | undefined,
): E[] {
  if (!ledger) return [];
  const repos = ledger.repos ?? {};
  return ledger.events.filter((e) => !repos[e.repo]?.gone);
}
