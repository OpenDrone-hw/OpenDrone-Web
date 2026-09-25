/**
 * Abuse limits for the support routes. The per-isolate limiter
 * (app/lib/rate-limit.ts) slows floods cheaply; the per-email daily cap on
 * new tickets is counted in D1, so it holds across isolates.
 */
import {checkRateLimit, type RateLimitResult} from '../rate-limit.ts';
import type {SupportStore} from './store.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const SUPPORT_LIMITS = {
  /** New tickets per IP. */
  create: {limit: 6, windowMs: HOUR},
  /** Customer replies per ticket. */
  reply: {limit: 15, windowMs: 10 * MINUTE},
  /** Ticket page refreshes per ticket (the page asks every 8 to 30 s). */
  poll: {limit: 40, windowMs: MINUTE},
  /** Find-my-ticket attempts per IP and per email. */
  find: {limit: 10, windowMs: HOUR},
  /** Resume-link opens per IP. */
  resume: {limit: 30, windowMs: HOUR},
  /** Attachment downloads per ticket. */
  file: {limit: 60, windowMs: HOUR},
} as const;

export type SupportLimit = keyof typeof SUPPORT_LIMITS;

export function supportRateLimit(kind: SupportLimit, key: string): RateLimitResult {
  const {limit, windowMs} = SUPPORT_LIMITS[kind];
  return checkRateLimit(`support:${kind}:${key}`, limit, windowMs);
}

export const TICKETS_PER_EMAIL_PER_DAY = 5;

/** True when this email already opened the day's allowance of tickets. */
export async function emailOverDailyLimit(store: SupportStore, email: string, now = Date.now()): Promise<boolean> {
  return (await store.countByEmailSince(email, now - 24 * HOUR)) >= TICKETS_PER_EMAIL_PER_DAY;
}
