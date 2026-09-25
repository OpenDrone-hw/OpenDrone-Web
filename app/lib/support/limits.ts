/**
 * Abuse limits for the support routes.
 *
 * Creating and finding tickets are the anonymous doors, so their counters
 * live in D1 (`support_rate`) and hold across isolates. They are keyed by
 * IP, and by IP plus email, never by email alone: someone else typing your
 * email can never lock you out of opening or finding your own tickets.
 * Keys are HMACs, so D1 holds no raw IP or email; rows go after a day.
 *
 * Requests on one ticket (reply, solve, reset, refresh, attachments) are
 * limited per isolate and only after the browser proved it may open the
 * ticket, so a stranger who knows a ticket number cannot exhaust its
 * owner's allowance.
 */
import {checkRateLimit, type RateLimitResult} from '../rate-limit.ts';
import type {SupportStore} from './store.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Per ticket, after authorisation, per isolate. */
export const TICKET_LIMITS = {
  /** Replies, "mark solved" and "replace link". */
  write: {limit: 15, windowMs: 10 * MINUTE},
  /** Page refreshes (the page asks every 8 to 30 s). */
  poll: {limit: 40, windowMs: MINUTE},
  /** Attachment downloads. */
  file: {limit: 60, windowMs: HOUR},
} as const;

export function ticketRateLimit(kind: keyof typeof TICKET_LIMITS, ref: string): RateLimitResult {
  const {limit, windowMs} = TICKET_LIMITS[kind];
  return checkRateLimit(`support:${kind}:${ref}`, limit, windowMs);
}

/** Resume-link opens per IP, per isolate (a bad token costs one HMAC). */
export function resumeRateLimit(ip: string): RateLimitResult {
  return checkRateLimit(`support:resume:${ip}`, 30, HOUR);
}

/** Anonymous doors, counted in D1. */
export const DOOR_LIMITS = {
  createPerIp: {limit: 6, windowMs: HOUR},
  createPerIpEmail: {limit: 5, windowMs: DAY},
  findPerIp: {limit: 10, windowMs: HOUR},
  findPerIpEmail: {limit: 5, windowMs: HOUR},
} as const;

type Door = keyof typeof DOOR_LIMITS;

/**
 * Order-number misses in "find my ticket", per email and across every IP:
 * a leaky bucket of FIND_MISS_CAPACITY that drains one miss every
 * FIND_MISS_DRAIN_MS. Order numbers are sequential, so without it a guesser
 * with many IPs could walk them for one email. The ticket number still
 * finds a ticket while the bucket is full.
 */
export const FIND_MISS_CAPACITY = 8;
export const FIND_MISS_DRAIN_MS = 6 * HOUR;

const enc = new TextEncoder();

async function hashKey(secret: string, parts: string[]): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(parts.join('\u0000'))));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The address a limit counts: an IPv4 address as is, an IPv6 address by
 * its /64 (one subscriber usually holds a whole /64, so counting single
 * addresses would give them billions of tries).
 */
export function ipBucket(ip: string): string {
  const raw = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!raw.includes(':')) return raw;
  const mapped = raw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1]!;
  const [head = '', tail] = raw.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  const groups = [...left, ...fill, ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return raw;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Count one attempt through an anonymous door, rule by rule in the order
 * given (per IP first). The first rule over its limit answers false and
 * the later rules are not counted, so a blocked IP writes no IP-plus-email
 * rows. A counter that cannot be written fails open: the in-memory limit
 * still applies. The first part of every rule is the client IP.
 */
export async function doorAllowed(
  store: SupportStore,
  secret: string,
  rules: Array<[Door, ...string[]]>,
  now = Date.now(),
): Promise<boolean> {
  for (const [door, ip = '', ...rest] of rules) {
    const parts = [ipBucket(ip), ...rest];
    const {limit, windowMs} = DOOR_LIMITS[door];
    // Isolate-local first: cheap and survives a D1 hiccup.
    if (!checkRateLimit(`support:${door}:${parts.join('|')}`, limit, windowMs).allowed) return false;
    try {
      const count = await store.hit(await hashKey(secret, [door, ...parts]), windowMs, now);
      if (count > limit) return false;
    } catch {
      console.warn('[support] rate counter unavailable', door);
    }
  }
  return true;
}

const DRAIN_PER_MS = 1 / FIND_MISS_DRAIN_MS;

/** Whether this email may try another order number. Fails open without D1. */
export async function orderGuessAllowed(store: SupportStore, secret: string, email: string, now = Date.now()): Promise<boolean> {
  try {
    const level = await store.bucket(await hashKey(secret, ['findMiss', email]), 0, DRAIN_PER_MS, now);
    return level + 1 <= FIND_MISS_CAPACITY;
  } catch {
    console.warn('[support] find miss counter unavailable');
    return true;
  }
}

/** Record an order number Shopify did not confirm for this email. */
export async function recordOrderMiss(store: SupportStore, secret: string, email: string, now = Date.now()): Promise<void> {
  try {
    await store.bucket(await hashKey(secret, ['findMiss', email]), 1, DRAIN_PER_MS, now);
  } catch {
    console.warn('[support] find miss counter unavailable');
  }
}
