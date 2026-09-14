/**
 * Tiny Upstash Redis REST client.
 *
 * Oxygen does not expose Cloudflare Workers KV bindings, so the support
 * ticket index uses Upstash (https://upstash.com) as a serverless KV
 * over HTTPS. We hit the REST API directly — no SDK — to keep the bundle
 * small and avoid pulling in a Node-shimmed dependency on the edge.
 *
 * Auth: Bearer token. Requests are JSON-array form, e.g.
 *   ["GET", "tk:1234"]
 *   ["SET", "tk:1234", "{...}", "EX", "63072000"]
 *
 * The client returns `null` from get() on missing keys (matching the
 * KVNamespace contract the index module was built against), so the
 * surrounding code didn't need to learn a new shape.
 */

export type UpstashEnv = {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
};

export type TicketStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: {expirationTtl?: number}): Promise<void>;
  putIfAbsent(
    key: string,
    value: string,
    opts?: {expirationTtl?: number},
  ): Promise<boolean>;
  delete(key: string): Promise<void>;
  putHashIfAbsent(key: string, field: string, value: string): Promise<boolean>;
  getHash(key: string): Promise<Record<string, string>>;
  deleteHashField(key: string, field: string): Promise<void>;
  // Iterate keys matching `pattern` (Redis glob — e.g. "tk:*"). Returns
  // every match in one batch; suitable for bounded indexes (we cap each
  // per-customer list at 200 and don't expect more than a few thousand
  // tickets globally). Wraps SCAN so we don't depend on the cursor
  // being exposed to callers.
  scan(pattern: string): Promise<string[]>;
};

export function getTicketStore(env: UpstashEnv): TicketStore | null {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return {
    async get(key) {
      const r = await call(url, token, ['GET', key]);
      if (r === null || r === undefined) return null;
      return typeof r === 'string' ? r : String(r);
    },
    async put(key, value, opts) {
      const ttl = opts?.expirationTtl;
      const cmd =
        ttl && ttl > 0
          ? ['SET', key, value, 'EX', String(ttl)]
          : ['SET', key, value];
      await call(url, token, cmd);
    },
    async putIfAbsent(key, value, opts) {
      const ttl = opts?.expirationTtl;
      const cmd =
        ttl && ttl > 0
          ? ['SET', key, value, 'NX', 'EX', String(ttl)]
          : ['SET', key, value, 'NX'];
      return (await call(url, token, cmd)) === 'OK';
    },
    async delete(key) {
      await call(url, token, ['DEL', key]);
    },
    async putHashIfAbsent(key, field, value) {
      return Number(await call(url, token, ['HSETNX', key, field, value])) === 1;
    },
    async getHash(key) {
      const result = await call(url, token, ['HGETALL', key]);
      if (!Array.isArray(result)) return {};
      const entries: Array<[string, string]> = [];
      for (let i = 0; i + 1 < result.length; i += 2) {
        entries.push([String(result[i]), String(result[i + 1])]);
      }
      return Object.fromEntries(entries);
    },
    async deleteHashField(key, field) {
      await call(url, token, ['HDEL', key, field]);
    },
    async scan(pattern) {
      const out = new Set<string>();
      let cursor = '0';
      // Hard cap to avoid runaway SCAN loops if a misconfigured pattern
      // somehow hits a huge keyspace. 50 iterations × 100 ≈ 5k keys.
      for (let i = 0; i < 50; i++) {
        const r = (await call(url, token, [
          'SCAN',
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          '100',
        ])) as [string, string[]] | unknown;
        if (!Array.isArray(r) || r.length < 2) break;
        cursor = String(r[0]);
        const batch = Array.isArray(r[1]) ? (r[1] as string[]) : [];
        for (const k of batch) out.add(k);
        if (cursor === '0') break;
      }
      return Array.from(out);
    },
  };
}

/**
 * Fixed-window rate limit, backed by Upstash so the counter is shared
 * across all Worker isolates (unlike the in-memory limiter, which each
 * isolate keeps privately and an attacker can sidestep by spreading
 * requests). Standard INCR + EXPIRE-on-first-hit pattern.
 *
 * Returns `{allowed, count}`, or `null` when Upstash isn't configured —
 * the caller falls back to the in-memory limiter in that case. Also
 * returns `null` on any Upstash error so a transient KV outage fails
 * soft (degrade to in-memory) rather than locking the endpoint.
 */
export async function globalRateLimit(
  env: UpstashEnv,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{allowed: boolean; count: number} | null> {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await call(url, token, ['INCR', `rl:${key}`]);
    const count = typeof r === 'number' ? r : Number(r) || 0;
    // Set the TTL only when we created the key (count === 1); on later
    // hits the window is already ticking. Worst case (a crash between
    // INCR and EXPIRE) leaves a key without TTL — INCR keeps climbing so
    // it stays blocked, which fails closed for that one key, acceptable.
    if (count === 1) {
      await call(url, token, ['EXPIRE', `rl:${key}`, String(windowSeconds)]);
    }
    return {allowed: count <= limit, count};
  } catch {
    return null;
  }
}

/**
 * Atomic counter increment (INCR), no TTL. Added for the growth ledger's
 * per-day checkout-click counters (`chk:<day>`, app/lib/growth/ledger.ts);
 * a GET/SET read-modify-write would race under concurrent beacons.
 * Returns the post-increment value, or null when Upstash is unconfigured
 * or the call failed (degrade-soft, caller decides whether to warn).
 */
export async function increment(
  env: UpstashEnv,
  key: string,
): Promise<number | null> {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await call(url, token, ['INCR', key]);
    return typeof r === 'number' ? r : Number(r) || 0;
  } catch {
    return null;
  }
}

/**
 * Atomic set-if-absent (SET ... NX), no TTL. Added for the growth
 * ledger's one-shot Purchase-event claim (`pev:<order_id>`,
 * app/lib/growth/ledger.ts): concurrent webhook deliveries in separate
 * isolates need a single winner, and a GET-then-SET check races.
 * Returns true when this call set the key (claim won), false when the
 * key already existed (claim lost), null when Upstash is unconfigured
 * or the call failed (degrade-soft, caller decides the fallback).
 */
export async function setIfAbsent(
  env: UpstashEnv,
  key: string,
  value: string,
): Promise<boolean | null> {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await call(url, token, ['SET', key, value, 'NX']);
    // Redis: "OK" when set, null bulk reply when the key already existed.
    return r === 'OK';
  } catch {
    return null;
  }
}

/**
 * Atomic set-if-absent with expiry (SET ... NX EX). Same contract as
 * setIfAbsent but the claim self-releases after `ttlSeconds` — used by
 * the back-in-stock cooldown latch (`bis:<handle>`), where a restock
 * that flaps in and out of stock must not re-blast the segment daily.
 */
export async function setIfAbsentTtl(
  env: UpstashEnv,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<boolean | null> {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await call(url, token, [
      'SET',
      key,
      value,
      'NX',
      'EX',
      String(ttlSeconds),
    ]);
    return r === 'OK';
  } catch {
    return null;
  }
}

/**
 * Delete a key (DEL). Counterpart to setIfAbsent for releasing a claim
 * whose protected action failed. Best-effort: returns false when
 * Upstash is unconfigured or the call failed.
 */
export async function deleteKey(
  env: UpstashEnv,
  key: string,
): Promise<boolean> {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    await call(url, token, ['DEL', key]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomic list append: LPUSH + LTRIM to `cap` entries (newest first).
 * Added for the growth ledger's append-only indexes (app/lib/growth/
 * ledger.ts) — the TicketStore shape above has no list primitive and a
 * GET/SET read-modify-write would race under concurrent webhooks.
 * Returns false when Upstash is unconfigured or the write failed; the
 * caller decides whether that's warn-worthy.
 */
export async function listPush(
  env: UpstashEnv,
  key: string,
  value: string,
  cap = 5000,
): Promise<boolean> {
  const url = env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, '');
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return false;
  try {
    await call(url, token, ['LPUSH', key, value]);
    await call(url, token, ['LTRIM', key, '0', String(cap - 1)]);
    return true;
  } catch {
    return false;
  }
}

async function call(
  url: string,
  token: string,
  command: string[],
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`upstash ${command[0]} ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {result?: unknown; error?: string};
  if (json.error) throw new Error(`upstash ${command[0]}: ${json.error}`);
  return json.result ?? null;
}
