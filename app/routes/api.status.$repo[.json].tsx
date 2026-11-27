import type {Route} from './+types/api.status.$repo[.json]';
import {
  ROADMAP,
  STATUS_ORDER,
  fetchStatusFlags,
  type ProductStatus,
} from '~/lib/roadmap-data';

/**
 * Shields.io endpoint badge for a board repo's product status.
 *
 * `https://img.shields.io/endpoint?url=https://opendrone.be/api/status/<Repo>.json`
 * renders the same status the roadmap and the shop resolve, from the same
 * `status-*` topic fetch, so a README badge can never disagree with the
 * site. A repo whose topic cannot be fetched gets its static fallback,
 * exactly like every other surface (docs/product-status.md).
 *
 * Repos outside ROADMAP (a variant board such as OpenAIO-Whoop that shares
 * its parent's roadmap card, or a repo that ROADMAP only names via `repo`
 * while it is private) still get a badge: the ROADMAP `repo` field serves
 * the static status, and any other public OpenDrone-hw repo has its
 * `status-*` topic fetched directly, cached 10 minutes per isolate. A failed
 * fetch (GitHub rate limit from the Worker egress) falls back to
 * BADGE_FALLBACK, the static status of the hub repos that carry a badge but
 * no roadmap card; like the ROADMAP fallbacks it must lag the topic, never
 * lead it. Any other repo with no fetchable status topic is 404.
 *
 * Cache: 600 s, the same ceiling as the feeds, so a topic flip reaches the
 * badge in the same window it reaches the shop. `cacheSeconds` tells
 * shields not to hold it longer either.
 */

const COLOR: Record<ProductStatus, string> = {
  launched: 'ffb700',
  beta: 'ffb700',
  alpha: 'e08c00',
  'in-progress': '6b6459',
  planned: '6b6459',
};

const LABEL: Record<ProductStatus, string> = {
  launched: 'launched',
  beta: 'beta',
  alpha: 'alpha',
  'in-progress': 'in progress',
  planned: 'planned',
};

// Badge repos without a roadmap card: the static status served when the
// live topic cannot be fetched.
const BADGE_FALLBACK: Record<string, ProductStatus> = {
  OpenRX: 'alpha',
};

// Topic fetches for repos ROADMAP does not link, keyed by repo name. Same
// 10 minute TTL as the ROADMAP fan-out; a miss (private repo, no status
// topic, API down) is cached too so a broken badge cannot poll GitHub.
const extraCache = new Map<string, {at: number; status?: ProductStatus}>();

async function fetchRepoStatus(
  repo: string,
  token?: string,
): Promise<ProductStatus | undefined> {
  const hit = extraCache.get(repo);
  if (hit && Date.now() - hit.at < 600_000) return hit.status;
  let status: ProductStatus | undefined;
  try {
    const res = await fetch(
      `https://api.github.com/repos/OpenDrone-hw/${repo}/topics`,
      {
        headers: {
          'User-Agent': 'opendrone-store-roadmap',
          Accept: 'application/vnd.github+json',
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
        },
        signal: AbortSignal.timeout(3500),
      },
    );
    if (!res.ok) {
      console.warn('[api.status]', repo, 'GitHub topics HTTP', res.status);
    } else {
      const data = (await res.json()) as {names?: string[]};
      const flag = data.names
        ?.find((t) => t.startsWith('status-'))
        ?.slice('status-'.length);
      if (flag && (STATUS_ORDER as string[]).includes(flag)) {
        status = flag as ProductStatus;
      }
    }
  } catch {
    // Unreachable API: no status this round.
  }
  extraCache.set(repo, {at: Date.now(), status});
  return status;
}

export async function loader({params, context}: Route.LoaderArgs) {
  const repo = params.repo ?? '';
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
    return new Response('not found', {status: 404});
  }
  const env = context.env as unknown as Record<string, string | undefined>;
  const token = env.GITHUB_STATUS_TOKEN;
  const link = `https://github.com/OpenDrone-hw/${repo}`;
  const item = ROADMAP.find((r) => r.link === link || r.repo === repo);
  let status: ProductStatus | undefined;
  if (item?.link) {
    const flags = await fetchStatusFlags(token).catch(
      () => ({}) as Record<string, ProductStatus>,
    );
    status = flags[link] ?? item.status;
  } else if (item) {
    status = item.status;
  } else {
    status = (await fetchRepoStatus(repo, token)) ?? BADGE_FALLBACK[repo];
  }
  if (!status) {
    return new Response('not found', {status: 404});
  }
  const body = {
    schemaVersion: 1,
    label: 'status',
    message: LABEL[status],
    color: COLOR[status],
    cacheSeconds: 600,
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
