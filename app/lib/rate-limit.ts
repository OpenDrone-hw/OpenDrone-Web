/**
 * Per-isolate, in-memory sliding-window rate limiter.
 *
 * Best-effort - Cloudflare Workers run many isolates per PoP and state is
 * not shared across them, so a determined attacker can still burst. Pair
 * this with a real edge rate limit (Cloudflare dashboard → Rules → Rate
 * Limiting Rules) for full coverage. The limiter here discourages casual
 * floods and keeps bots from chewing a single isolate's Discord / upstream
 * quota in a loop.
 */

type Bucket = {count: number; resetAt: number};

const BUCKETS = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetInSeconds: number;
};

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const bucket = BUCKETS.get(key);
  if (!bucket || bucket.resetAt <= now) {
    BUCKETS.set(key, {count: 1, resetAt: now + windowMs});
    if (BUCKETS.size > MAX_BUCKETS) gcExpired(now);
    return {allowed: true, remaining: limit - 1, resetInSeconds: Math.ceil(windowMs / 1000)};
  }
  if (bucket.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetInSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }
  bucket.count++;
  return {
    allowed: true,
    remaining: limit - bucket.count,
    resetInSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

function gcExpired(now: number) {
  for (const [k, v] of BUCKETS) {
    if (v.resetAt <= now) BUCKETS.delete(k);
    if (BUCKETS.size <= MAX_BUCKETS * 0.8) break;
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

/**
 * Shape of a Cloudflare Workers Rate Limiting binding
 * (wrangler.toml `[[ratelimits]]`), declared minimally in env.d.ts. Each
 * binding is pre-configured with one fixed `limit`/`period` pair at deploy
 * time - the period can only be 10 or 60 seconds (a Cloudflare platform
 * limit) - so a distinct cap needs its own binding, not a parameter here.
 */
export type WorkersRateLimiter = {
  limit(options: {key: string}): Promise<{success: boolean}>;
};

/**
 * Distributed rate limit backed by a Workers Rate Limiting binding -
 * shared across isolates, unlike checkRateLimit above. Returns `null` when
 * the binding is missing (e.g. local dev, where wrangler.toml's
 * `[[ratelimits]]` entries aren't simulated), so the caller can fall back
 * to the in-memory limiter, matching the degrade-soft pattern used
 * throughout this codebase's other external calls.
 */
export async function bindingRateLimit(
  binding: WorkersRateLimiter | undefined,
  key: string,
): Promise<{allowed: boolean} | null> {
  if (!binding) return null;
  try {
    const {success} = await binding.limit({key});
    return {allowed: success};
  } catch (err) {
    console.warn('[rate-limit] Workers Rate Limiting binding call failed', err);
    return null;
  }
}
