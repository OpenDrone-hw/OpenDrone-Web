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

const enc = new TextEncoder();

async function hashKey(secret: string, parts: string[]): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(parts.join('\u0000'))));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Count one attempt through an anonymous door against every rule given.
 * Returns false when any rule is over its limit. A counter that cannot be
 * written fails open: the in-memory per-IP limit below still applies.
 */
export async function doorAllowed(
  store: SupportStore,
  secret: string,
  rules: Array<[Door, ...string[]]>,
  now = Date.now(),
): Promise<boolean> {
  let allowed = true;
  for (const [door, ...parts] of rules) {
    const {limit, windowMs} = DOOR_LIMITS[door];
    // Isolate-local first: cheap and survives a D1 hiccup.
    if (!checkRateLimit(`support:${door}:${parts.join('|')}`, limit, windowMs).allowed) allowed = false;
    try {
      const count = await store.hit(await hashKey(secret, [door, ...parts]), windowMs, now);
      if (count > limit) allowed = false;
    } catch {
      console.warn('[support] rate counter unavailable', door);
    }
  }
  return allowed;
}
