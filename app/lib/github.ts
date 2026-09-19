/**
 * Fetches the latest commit and the contributor list for a PDP's repos.
 *
 * Auth is optional but strongly wanted. Unauthenticated, GitHub allows 60
 * calls an hour per IP, shared across every repo and every visitor behind
 * that IP, and a PDP asks for several. Exhausting it is routine, not an
 * edge case, and it silently empties the contributor grid. Set GITHUB_TOKEN
 * (a fine-grained token with public read access, no scopes needed for
 * public repos) and the ceiling becomes 5000/hour. Without it everything
 * still works and simply degrades to the empty state.
 */

/** Shared request headers; adds Authorization only when a token exists. */
function ghHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    'User-Agent': 'opendrone-web',
    Accept: 'application/vnd.github+json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export type LatestCommit = {
  sha: string;
  shortSha: string;
  message: string;          // first line of the commit message
  author: string;
  date: string;             // ISO
  url: string;              // html_url of the commit
  repoUrl: string;          // original https://github.com/... input
  repoLabel: string;        // just the repo name, for display
};

export function parseRepoUrl(
  repoUrl: string,
): {owner: string; repo: string} | null {
  const m = repoUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  return {owner: m[1], repo: m[2].replace(/\.git$/, '')};
}

export async function fetchLatestCommit(
  repoUrl: string,
  token?: string,
): Promise<LatestCommit | null> {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed) return null;
  try {
    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?per_page=1`;
    const res = await fetch(url, {
      headers: ghHeaders(token),
      signal: AbortSignal.timeout(4000),
      // Cloudflare / Oxygen edge-cache hint - keep GitHub origin hits
      // to roughly once every 5 minutes per PoP. Safe cast because
      // the RequestInit type doesn't know about `cf`.
      ...({cf: {cacheTtl: 300, cacheEverything: true}} as RequestInit),
    });
    if (!res.ok) {
      console.warn('[github]', parsed.owner + '/' + parsed.repo, res.status);
      return null;
    }
    const data = (await res.json()) as Array<{
      sha: string;
      html_url: string;
      commit: {
        message: string;
        author: {name: string; date: string};
      };
      author?: {login: string} | null;
    }>;
    if (!Array.isArray(data) || !data.length) return null;
    const c = data[0];
    return {
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: (c.commit?.message ?? '').split('\n')[0],
      author: c.commit?.author?.name ?? c.author?.login ?? 'unknown',
      date: c.commit?.author?.date ?? '',
      url: c.html_url,
      repoUrl,
      repoLabel: parsed.repo,
    };
  } catch (err) {
    console.warn('[github] fetch failed', repoUrl, err);
    return null;
  }
}

export async function fetchLatestCommits(
  repoUrls: string[],
  token?: string,
): Promise<LatestCommit[]> {
  const unique = Array.from(new Set(repoUrls));
  // Arrow, not a bare reference: map passes (value, index, array), so
  // `map(fetchLatestCommit)` would hand the array index to `token`.
  const results = await Promise.all(
    unique.map((repoUrl) => fetchLatestCommit(repoUrl, token)),
  );
  return results.filter((c): c is LatestCommit => c !== null);
}

export type Contributor = {
  login: string;
  avatarUrl: string;
  htmlUrl: string;
  /** Commit count summed across every repo we asked about. */
  contributions: number;
};

/**
 * Contributors across a product's repos, merged by login, bots dropped,
 * sorted by total commits. Same unauthenticated-API budget as the
 * latest-commit fetch, so the edge cache TTL is a full hour - the list
 * changes slowly and a stale hour costs nothing.
 */
export async function fetchContributors(
  repoUrls: string[],
  limit = 12,
  token?: string,
): Promise<Contributor[]> {
  const unique = Array.from(new Set(repoUrls));
  const perRepo = await Promise.all(
    unique.map(async (repoUrl) => {
      const parsed = parseRepoUrl(repoUrl);
      if (!parsed) return [];
      try {
        const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contributors?per_page=30`;
        const res = await fetch(url, {
          headers: ghHeaders(token),
          signal: AbortSignal.timeout(4000),
          ...({cf: {cacheTtl: 3600, cacheEverything: true}} as RequestInit),
        });
        if (!res.ok) {
          console.warn('[github] contributors', parsed.repo, res.status);
          return [];
        }
        const data = (await res.json()) as Array<{
          login?: string;
          avatar_url?: string;
          html_url?: string;
          contributions?: number;
          type?: string;
        }>;
        return Array.isArray(data) ? data : [];
      } catch (err) {
        console.warn('[github] contributors fetch failed', repoUrl, err);
        return [];
      }
    }),
  );
  const merged = new Map<string, Contributor>();
  for (const row of perRepo.flat()) {
    if (!row.login || !row.avatar_url || !row.html_url) continue;
    if (row.type === 'Bot' || row.login.endsWith('[bot]')) continue;
    const prev = merged.get(row.login);
    if (prev) {
      prev.contributions += row.contributions ?? 0;
    } else {
      merged.set(row.login, {
        login: row.login,
        avatarUrl: row.avatar_url,
        htmlUrl: row.html_url,
        contributions: row.contributions ?? 0,
      });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.contributions - a.contributions)
    .slice(0, limit);
}
