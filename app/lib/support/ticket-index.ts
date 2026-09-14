/**
 * Ticket index — fast lookup layer for support tickets.
 *
 * Discord remains the source of truth for thread *content*. This module
 * indexes ticket *metadata* so list/count/feedback queries don't require
 * scanning Discord. Built for thousands of tickets per customer.
 *
 * Storage layout (when the Upstash store is configured):
 *   tk:{tid}                 -> per-ticket meta (single source of truth)
 *   idx:email:{emailHashHex} -> same, for anon/email-resume path
 *   fb:{tid}                 -> feedback record (rating + notes), if submitted
 *
 * Lists are capped at MAX_INDEX_ENTRIES (200) most-recent. Older tickets
 * still resolvable by tid via tk:{tid}; we just don't paginate further
 * back from the index. At our volume (per-customer), 200 covers years.
 *
 * Fallback: when UPSTASH_REDIS_REST_URL/TOKEN are unset, list operations
 * degrade to a Discord forum scan via findThreadsByEmail. add/close/
 * feedback writes become no-ops on the index side; the Discord thread
 * itself still gets the close marker and feedback post.
 */

import {findThreadsByEmail} from './discord';
import {getTicketStore, type TicketStore, type UpstashEnv} from './upstash';

export type TicketStatus = 'open' | 'closed';

export type TicketIndexEntry = {
  tid: string; // Discord thread id
  pid: string; // 10-digit public ref
  subject: string;
  openedAt: number; // unix seconds
  closedAt: number | null;
  lastActivityAt: number; // unix seconds; bumped on every send
  status: TicketStatus;
  feedbackSubmitted?: boolean;
  // Optional intake fields surfaced in the active-ticket sidebar.
  product?: string;
  firmware?: string;
};

export type TicketMeta = TicketIndexEntry & {
  email: string;
  name: string;
  // Newest Discord message id the customer's widget delivered while the
  // tab was visible. Written by /api/support/poll (best-effort).
  seenCursor?: string;
  // Discord message id up to which the reply-notification sweep has
  // settled its email decisions. Written by /api/support/notify.
  notifyCursor?: string;
};

const MAX_INDEX_ENTRIES = 200;
const META_TTL_SECONDS = 60 * 60 * 24 * 365 * 2; // 2 years

type Env = UpstashEnv & {
  DISCORD_BOT_TOKEN?: string;
  DISCORD_SUPPORT_CHANNEL_ID?: string;
  DISCORD_GUILD_ID?: string;
};

export function hasTicketStore(env: UpstashEnv): boolean {
  return getTicketStore(env) !== null;
}

// Stable, lowercase, no PII leakage in the key itself. Keys are not
// secrets but emails as raw KV keys would leak via list operations and
// Cloudflare logs.
async function emailKey(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(buf);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.slice(0, 32);
}

export async function addTicket(
  env: Env,
  meta: TicketMeta,
): Promise<void> {
  const kv = getTicketStore(env);
  if (!kv) return;
  const entry: TicketIndexEntry = {
    tid: meta.tid,
    pid: meta.pid,
    subject: meta.subject,
    openedAt: meta.openedAt,
    closedAt: meta.closedAt,
    lastActivityAt: meta.lastActivityAt,
    status: meta.status,
  };
  const writes: Promise<unknown>[] = [
    kv.put(`tk:${meta.tid}`, JSON.stringify(meta), {
      expirationTtl: META_TTL_SECONDS,
    }),
  ];
  if (meta.email) {
    const ek = await emailKey(meta.email);
    writes.push(prependIndex(kv, `idx:email:${ek}`, entry));
  }
  await Promise.all(writes);
}

export async function bumpActivity(
  env: Env,
  tid: string,
): Promise<void> {
  const kv = getTicketStore(env);
  if (!kv) return;
  const meta = await getMeta(env, tid);
  if (!meta) return;
  meta.lastActivityAt = Math.floor(Date.now() / 1000);
  await Promise.all([
    kv.put(`tk:${tid}`, JSON.stringify(meta), {
      expirationTtl: META_TTL_SECONDS,
    }),
    updateInIndex(kv, meta, (e) => {
      e.lastActivityAt = meta.lastActivityAt;
    }),
  ]);
}

export async function closeTicket(env: Env, tid: string): Promise<void> {
  const kv = getTicketStore(env);
  if (!kv) return;
  const meta = await getMeta(env, tid);
  if (!meta) return;
  const now = Math.floor(Date.now() / 1000);
  meta.status = 'closed';
  meta.closedAt = now;
  meta.lastActivityAt = now;
  await Promise.all([
    kv.put(`tk:${tid}`, JSON.stringify(meta), {
      expirationTtl: META_TTL_SECONDS,
    }),
    updateInIndex(kv, meta, (e) => {
      e.status = 'closed';
      e.closedAt = now;
      e.lastActivityAt = now;
    }),
  ]);
}

// Drop a ticket from every index it appears in. Idempotent — safe to
// call when the ticket was never indexed (no-op).
export async function removeTicket(env: Env, tid: string): Promise<void> {
  const kv = getTicketStore(env);
  if (!kv) return;
  const meta = await getMeta(env, tid);
  // Remove from per-customer + per-email indexes first so list views
  // stop returning the ticket even if the meta delete races.
  if (meta) {
    const indexKeys: string[] = [];
    if (meta.email) indexKeys.push(`idx:email:${await emailKey(meta.email)}`);
    await Promise.all(
      indexKeys.map(async (key) => {
        const list = parseIndex(await kv.get(key));
        const next = list.filter((e) => e.tid !== tid);
        if (next.length !== list.length) {
          await kv.put(key, JSON.stringify(next));
        }
      }),
    );
  }
  // Tombstone the meta + feedback records by writing empty strings with
  // a 1-day TTL — Upstash REST doesn't expose DEL via this client, but
  // a short-lived empty value is functionally equivalent for getMeta.
  await Promise.all([
    kv.put(`tk:${tid}`, '', {expirationTtl: 60 * 60 * 24}),
    kv.put(`fb:${tid}`, '', {expirationTtl: 60 * 60 * 24}),
  ]);
}

export async function markFeedback(env: Env, tid: string): Promise<void> {
  const kv = getTicketStore(env);
  if (!kv) return;
  const meta = await getMeta(env, tid);
  if (!meta) return;
  meta.feedbackSubmitted = true;
  await Promise.all([
    kv.put(`tk:${tid}`, JSON.stringify(meta), {
      expirationTtl: META_TTL_SECONDS,
    }),
    updateInIndex(kv, meta, (e) => {
      e.feedbackSubmitted = true;
    }),
  ]);
}

// Merge cursor fields into a ticket's meta record. Cursor-only patch:
// index entries don't carry these fields, so no index write is needed.
export async function patchMeta(
  env: Env,
  tid: string,
  patch: Partial<Pick<TicketMeta, 'seenCursor' | 'notifyCursor'>>,
): Promise<void> {
  const kv = getTicketStore(env);
  if (!kv) return;
  const meta = await getMeta(env, tid);
  if (!meta) return;
  Object.assign(meta, patch);
  await kv.put(`tk:${tid}`, JSON.stringify(meta), {
    expirationTtl: META_TTL_SECONDS,
  });
}

export async function getMeta(
  env: Env,
  tid: string,
): Promise<TicketMeta | null> {
  const kv = getTicketStore(env);
  if (!kv) return null;
  const raw = await kv.get(`tk:${tid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TicketMeta;
  } catch {
    return null;
  }
}

export type ListOpts = {
  status?: TicketStatus | 'all';
  limit?: number;
};

export async function listByEmail(
  env: Env,
  email: string,
  opts: ListOpts = {},
): Promise<TicketIndexEntry[]> {
  const kv = getTicketStore(env);
  if (kv) {
    const ek = await emailKey(email);
    const raw = await kv.get(`idx:email:${ek}`);
    return filterAndLimit(parseIndex(raw), opts);
  }
  // Fallback: scan Discord. Slow, only safe at low ticket volumes.
  const matches = await findThreadsByEmail(env, email);
  const entries: TicketIndexEntry[] = matches.map((m) => ({
    tid: m.id,
    pid: '',
    subject: m.name,
    openedAt: m.createdAt
      ? Math.floor(new Date(m.createdAt).getTime() / 1000)
      : 0,
    closedAt: m.archived ? Math.floor(Date.now() / 1000) : null,
    lastActivityAt: 0,
    status: m.archived || m.locked ? 'closed' : 'open',
  }));
  return filterAndLimit(entries, opts);
}

export async function countOpenForEmail(
  env: Env,
  email: string,
): Promise<number> {
  const list = await listByEmail(env, email, {status: 'open'});
  return list.length;
}

// Walk every ticket in the store. Used by /api/support/cleanup to find
// stale threads. Bounded by the SCAN cap in the Upstash client.
export async function listAllTickets(env: Env): Promise<TicketMeta[]> {
  const kv = getTicketStore(env);
  if (!kv) return [];
  const keys = await kv.scan('tk:*');
  const out: TicketMeta[] = [];
  await Promise.all(
    keys.map(async (k) => {
      const raw = await kv.get(k);
      if (!raw) return;
      try {
        out.push(JSON.parse(raw) as TicketMeta);
      } catch {
        /* tombstone or malformed — skip */
      }
    }),
  );
  return out;
}

function parseIndex(raw: string | null): TicketIndexEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TicketIndexEntry[]) : [];
  } catch {
    return [];
  }
}

function filterAndLimit(
  list: TicketIndexEntry[],
  opts: ListOpts,
): TicketIndexEntry[] {
  let out = list;
  if (opts.status && opts.status !== 'all') {
    out = out.filter((e) => e.status === opts.status);
  }
  out = [...out].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
  return out;
}

async function prependIndex(
  kv: TicketStore,
  key: string,
  entry: TicketIndexEntry,
): Promise<void> {
  const current = parseIndex(await kv.get(key));
  // De-dupe by tid (a re-create on the same thread shouldn't double-count).
  const filtered = current.filter((e) => e.tid !== entry.tid);
  const next = [entry, ...filtered].slice(0, MAX_INDEX_ENTRIES);
  await kv.put(key, JSON.stringify(next));
}

async function updateInIndex(
  kv: TicketStore,
  meta: TicketMeta,
  mutate: (entry: TicketIndexEntry) => void,
): Promise<void> {
  const keys: string[] = [];
  if (meta.email) keys.push(`idx:email:${await emailKey(meta.email)}`);
  await Promise.all(
    keys.map(async (key) => {
      const list = parseIndex(await kv.get(key));
      const idx = list.findIndex((e) => e.tid === meta.tid);
      if (idx < 0) {
        // Self-heal: ticket isn't in this index (race during create, or
        // an addTicket write that lost to a concurrent prepend). Insert
        // a fresh entry built from the current meta + the mutator —
        // closing a ticket should never silently fail to mark the
        // index entry as closed because the entry happened to be
        // missing.
        const entry: TicketIndexEntry = {
          tid: meta.tid,
          pid: meta.pid,
          subject: meta.subject,
          openedAt: meta.openedAt,
          closedAt: meta.closedAt,
          lastActivityAt: meta.lastActivityAt,
          status: meta.status,
        };
        mutate(entry);
        const next = [entry, ...list].slice(0, MAX_INDEX_ENTRIES);
        await kv.put(key, JSON.stringify(next));
        return;
      }
      mutate(list[idx]);
      await kv.put(key, JSON.stringify(list));
    }),
  );
}

export type Feedback = {
  tid: string;
  pid: string;
  email: string;
  speed: number; // 1-5
  helpfulness: number; // 1-5
  overall: number; // 1-5
  notes: string;
  submittedAt: number;
};

export async function saveFeedback(
  env: Env,
  feedback: Feedback,
): Promise<void> {
  const kv = getTicketStore(env);
  if (!kv) return;
  await kv.put(`fb:${feedback.tid}`, JSON.stringify(feedback), {
    expirationTtl: META_TTL_SECONDS,
  });
  await markFeedback(env, feedback.tid);
}

export async function getFeedback(
  env: Env,
  tid: string,
): Promise<Feedback | null> {
  const kv = getTicketStore(env);
  if (!kv) return null;
  const raw = await kv.get(`fb:${tid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Feedback;
  } catch {
    return null;
  }
}

/**
 * Long-term archive of a closed ticket. Written by the cleanup cron
 * before the Discord thread is deleted, so we keep a durable corpus of
 * (subject, conversation, feedback) tuples for AI training without
 * keeping the live Discord thread or the Upstash live index entry
 * around.
 *
 * Stored at archive:{tid} with NO TTL. Free-tier Upstash (256 MB)
 * holds ~25k–50k of these records assuming 5–10 KB per ticket; bump
 * the plan or rotate to object storage when that ceiling is in sight.
 */
export type ArchivedMessage = {
  // Discord author id is intentionally dropped; we only need the role
  // (staff vs customer vs bot/AI) and a display first name.
  role: 'staff' | 'customer' | 'bot';
  authorFirstName: string;
  content: string; // PII-scrubbed via scrubForPublic before write
  createdAt: string; // ISO from Discord
};

export type TicketArchive = {
  tid: string;
  pid: string;
  subject: string;
  product?: string;
  firmware?: string;
  openedAt: number;
  closedAt: number;
  lastActivityAt: number;
  archivedAt: number;
  removalReason: 'closed' | 'stale';
  messages: ArchivedMessage[];
  feedback: Feedback | null;
};

export async function archiveTicket(
  env: Env,
  archive: TicketArchive,
): Promise<void> {
  const kv = getTicketStore(env);
  if (!kv) return;
  // No expirationTtl → permanent.
  await kv.put(`archive:${archive.tid}`, JSON.stringify(archive));
}

export async function getArchive(
  env: Env,
  tid: string,
): Promise<TicketArchive | null> {
  const kv = getTicketStore(env);
  if (!kv) return null;
  const raw = await kv.get(`archive:${tid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TicketArchive;
  } catch {
    return null;
  }
}
