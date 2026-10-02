/**
 * Live size of the OpenDrone Discord, for the homepage community section.
 *
 * Discord's public invite endpoint returns approximate member and online
 * counts without a token. The Worker fetches it server-side only (the
 * browser never talks to Discord, so the CSP stays unchanged), and the
 * answer is held for an hour twice over: Cloudflare's edge cache through
 * `cf.cacheTtlByStatus` (successes only), and a per-isolate memory so a
 * busy page never fans out. A failure resolves to `null` and the page hides
 * the numbers; a miss is remembered for five minutes so a Discord outage or
 * rate limit is not polled on every request.
 */

import {DISCORD_INVITE_URL} from './company.ts';

export type DiscordCounts = {members: number; online: number};

/** `https://discord.gg/<code>` -> `<code>`. */
export function inviteCode(url: string): string | null {
  const m = url.match(/discord(?:\.gg|(?:app)?\.com\/invite)\/([\w-]+)/i);
  return m ? m[1] : null;
}

export function inviteApiUrl(url: string = DISCORD_INVITE_URL): string | null {
  const code = inviteCode(url);
  return code
    ? `https://discord.com/api/v10/invites/${code}?with_counts=true`
    : null;
}

/** The two counts from an invite response, or null when either is unusable. */
export function parseInviteCounts(body: unknown): DiscordCounts | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const members = b.approximate_member_count;
  const online = b.approximate_presence_count;
  const ok = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (!ok(members) || !ok(online) || online > members) return null;
  return {members: Math.round(members), online: Math.round(online)};
}

export const COUNTS_TTL_MS = 60 * 60 * 1000;
export const MISS_TTL_MS = 5 * 60 * 1000;
/** How old a stored count may be when Discord refuses a fresh one. */
export const STALE_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * Discord answers part of Cloudflare's shared egress with HTTP 429, so one
 * isolate may get the counts while its neighbour does not. The last good
 * answer is therefore also kept in the PoP's Cache API under this key:
 * fresh for an hour (no Discord call at all), and served stale for up to a
 * day when Discord refuses. Only then are the numbers hidden.
 */
export const COUNTS_CACHE_KEY = 'https://opendrone.be/__cache/discord-invite-counts';

/** The slice of the Workers Cache API this module uses. */
export type CountsCache = {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
};

type Stored = DiscordCounts & {at: number};

function defaultCache(): CountsCache | null {
  const c = (globalThis as {caches?: {default?: CountsCache}}).caches;
  return c?.default ?? null;
}

async function readStored(cache: CountsCache | null): Promise<Stored | null> {
  if (!cache) return null;
  try {
    const res = await cache.match(COUNTS_CACHE_KEY);
    if (!res) return null;
    const body = (await res.json()) as Partial<Stored>;
    const counts = parseInviteCounts({
      approximate_member_count: body.members,
      approximate_presence_count: body.online,
    });
    return counts && typeof body.at === 'number' ? {...counts, at: body.at} : null;
  } catch {
    return null;
  }
}

async function writeStored(cache: CountsCache | null, stored: Stored): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(
      COUNTS_CACHE_KEY,
      new Response(JSON.stringify(stored), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${STALE_MAX_MS / 1000}`,
        },
      }),
    );
  } catch {
    // A cache write failure only costs a refetch later.
  }
}

let memo: {at: number; ttl: number; counts: DiscordCounts | null} | null = null;
let inflight: Promise<DiscordCounts | null> | null = null;

/** Tests only: forget the per-isolate memory. */
export function resetDiscordCountsCache(): void {
  memo = null;
  inflight = null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function fetchDiscordCounts({
  fetchImpl = fetch,
  now = Date.now,
  inviteUrl = DISCORD_INVITE_URL,
  cache = defaultCache(),
}: {
  fetchImpl?: FetchLike;
  now?: () => number;
  inviteUrl?: string;
  cache?: CountsCache | null;
} = {}): Promise<DiscordCounts | null> {
  if (memo && now() - memo.at < memo.ttl) return memo.counts;
  if (inflight) return inflight;
  const api = inviteApiUrl(inviteUrl);
  if (!api) return null;
  inflight = (async () => {
    const stored = await readStored(cache);
    const age = stored ? now() - stored.at : Infinity;
    if (stored && age < COUNTS_TTL_MS) {
      const counts = {members: stored.members, online: stored.online};
      memo = {at: now(), ttl: COUNTS_TTL_MS - age, counts};
      return counts;
    }
    try {
      const res = await fetchImpl(api, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'DiscordBot (https://opendrone.be, 1)',
        },
        signal: AbortSignal.timeout(3000),
        // Cloudflare edge cache: an hour for a success, never for an error.
        ...({
          cf: {cacheTtlByStatus: {'200-299': 3600, '400-599': 0}},
        } as RequestInit),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const counts = parseInviteCounts(await res.json());
      if (!counts) throw new Error('no counts in the invite response');
      memo = {at: now(), ttl: COUNTS_TTL_MS, counts};
      await writeStored(cache, {...counts, at: now()});
      return counts;
    } catch (err) {
      const stale =
        stored && age < STALE_MAX_MS
          ? {members: stored.members, online: stored.online}
          : null;
      console.warn('[discord] invite counts unavailable', stale ? '(serving stored)' : '', err);
      memo = {at: now(), ttl: MISS_TTL_MS, counts: stale};
      return stale;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
