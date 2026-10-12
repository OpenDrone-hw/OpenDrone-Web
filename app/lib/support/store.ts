/**
 * The ticket store: D1 (`SUPPORT_DB`, schema in migrations/). One row per
 * ticket with its state, and the customer-visible copy of the conversation.
 * Every query is parameterised; nothing here logs personal data.
 */

export type TicketStatus = 'open' | 'waiting' | 'answered' | 'closed';
import type {TicketTopic} from './form.ts';

export type {TicketTopic};
/**
 * matched: linked to the one Shopify customer with this email, proven by an
 * order of that email. unverified: a customer has this email but nothing
 * proves the writer is them, so nothing is linked or shown.
 */
export type CustomerMatch = 'matched' | 'unverified' | 'none' | 'multiple' | 'unchecked';

export type Ticket = {
  ref: string;
  topic: TicketTopic;
  subject: string;
  status: TicketStatus;
  name: string;
  email: string;
  orderNumber: string | null;
  /** Shopify confirmed the order belongs to this email. */
  orderVerified: boolean;
  /** The team locked or deleted the thread; replies are refused. */
  locked: boolean;
  metaMessageId: string | null;
  preview: string;
  product: string | null;
  threadId: string;
  cursor: string | null;
  customerId: string | null;
  customerMatch: CustomerMatch;
  linkVersion: number;
  createdAt: number;
  updatedAt: number;
  lastCustomerAt: number;
  lastStaffAt: number | null;
  customerSeenAt: number | null;
  notifiedAt: number | null;
  syncedAt: number | null;
  closedAt: number | null;
  /** CRM (migration 0011). */
  assignee: string | null;
  priority: Priority;
  route: Route;
  tags: string[];
  communityConsent: boolean;
  communityPostId: string | null;
  communityCursor: string | null;
  communitySyncedAt: number | null;
  lastCommunityAt: number | null;
};

export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];
/** team: only staff see it. community: an anonymised question stands in the public help forum. */
export type Route = 'team' | 'community';

export type MessageRole = 'customer' | 'staff' | 'system' | 'community';

export type StoredAttachment = {id: string; filename: string; size: number};

export type TicketMessage = {
  seq: number;
  ref: string;
  discordId: string | null;
  role: MessageRole;
  author: string;
  body: string;
  attachments: StoredAttachment[];
  createdAt: number;
  /** A community reply a person marked as the answer. */
  answer: boolean;
};

export type Note = {id: number; ref: string; author: string; body: string; createdAt: number};
export type SavedReply = {id: number; title: string; body: string; updatedBy: string; createdAt: number; updatedAt: number};
export type AuditRow = {id: number; at: number; actor: string; action: string; ref: string | null; detail: string};

export type TicketFilter = {
  status?: TicketStatus[];
  route?: Route;
  /** A login, or 'none' for unassigned. */
  assignee?: string;
  priority?: Priority;
  topic?: TicketTopic;
  tag?: string;
  q?: string;
};

type TicketRow = {
  ref: string;
  topic: string;
  subject: string;
  status: string;
  name: string;
  email: string;
  order_number: string | null;
  order_verified: number;
  locked: number;
  meta_message_id: string | null;
  preview: string;
  product: string | null;
  thread_id: string;
  cursor: string | null;
  customer_id: string | null;
  customer_match: string;
  link_version: number;
  created_at: number;
  updated_at: number;
  last_customer_at: number;
  last_staff_at: number | null;
  customer_seen_at: number | null;
  notified_at: number | null;
  synced_at: number | null;
  closed_at: number | null;
  assignee: string | null;
  priority: string;
  route: string;
  tags: string;
  community_consent: number;
  community_post_id: string | null;
  community_cursor: string | null;
  community_synced_at: number | null;
  last_community_at: number | null;
};

type MessageRow = {
  seq: number;
  ref: string;
  discord_id: string | null;
  role: string;
  author: string;
  body: string;
  attachments: string;
  created_at: number;
  answer: number;
};

function parseTags(s: string): string[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

type SavedReplyRow = {id: number; title: string; body: string; updated_by: string; created_at: number; updated_at: number};
function toSaved(r: SavedReplyRow): SavedReply {
  return {id: Number(r.id), title: r.title, body: r.body, updatedBy: r.updated_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at)};
}

function toTicket(r: TicketRow): Ticket {
  return {
    ref: r.ref,
    topic: r.topic as TicketTopic,
    subject: r.subject,
    status: r.status as TicketStatus,
    name: r.name,
    email: r.email,
    orderNumber: r.order_number,
    orderVerified: Number(r.order_verified) === 1,
    locked: Number(r.locked) === 1,
    metaMessageId: r.meta_message_id,
    preview: r.preview ?? '',
    product: r.product,
    threadId: r.thread_id,
    cursor: r.cursor,
    customerId: r.customer_id,
    customerMatch: r.customer_match as CustomerMatch,
    linkVersion: Number(r.link_version),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastCustomerAt: Number(r.last_customer_at),
    lastStaffAt: r.last_staff_at === null ? null : Number(r.last_staff_at),
    customerSeenAt: r.customer_seen_at === null ? null : Number(r.customer_seen_at),
    notifiedAt: r.notified_at === null ? null : Number(r.notified_at),
    syncedAt: r.synced_at === null ? null : Number(r.synced_at),
    closedAt: r.closed_at === null ? null : Number(r.closed_at),
    assignee: r.assignee ?? null,
    priority: (PRIORITIES.includes(r.priority as Priority) ? r.priority : 'normal') as Priority,
    route: r.route === 'community' ? 'community' : 'team',
    tags: parseTags(r.tags ?? '[]'),
    communityConsent: Number(r.community_consent) === 1,
    communityPostId: r.community_post_id ?? null,
    communityCursor: r.community_cursor ?? null,
    communitySyncedAt: r.community_synced_at == null ? null : Number(r.community_synced_at),
    lastCommunityAt: r.last_community_at == null ? null : Number(r.last_community_at),
  };
}

function parseAttachments(s: string): StoredAttachment[] {
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? (v as StoredAttachment[]) : [];
  } catch {
    return [];
  }
}

function toMessage(r: MessageRow): TicketMessage {
  return {
    seq: Number(r.seq),
    ref: r.ref,
    discordId: r.discord_id,
    role: r.role as MessageRole,
    author: r.author,
    body: r.body,
    attachments: parseAttachments(r.attachments),
    createdAt: Number(r.created_at),
    answer: Number(r.answer) === 1,
  };
}

/** Columns a caller may change with `update`, camelCase to column. */
const COLUMNS = {
  status: 'status',
  locked: 'locked',
  metaMessageId: 'meta_message_id',
  cursor: 'cursor',
  customerId: 'customer_id',
  customerMatch: 'customer_match',
  linkVersion: 'link_version',
  updatedAt: 'updated_at',
  lastCustomerAt: 'last_customer_at',
  lastStaffAt: 'last_staff_at',
  customerSeenAt: 'customer_seen_at',
  notifiedAt: 'notified_at',
  syncedAt: 'synced_at',
  closedAt: 'closed_at',
  assignee: 'assignee',
  priority: 'priority',
  route: 'route',
  tags: 'tags',
  communityConsent: 'community_consent',
  communityPostId: 'community_post_id',
  communityCursor: 'community_cursor',
  communitySyncedAt: 'community_synced_at',
  lastCommunityAt: 'last_community_at',
} as const;

export type TicketPatch = Partial<Pick<Ticket, keyof typeof COLUMNS>>;

export type NewMessage = Omit<TicketMessage, 'seq' | 'answer'> & {answer?: boolean};

export function createStore(db: D1Database) {
  return {
    async insertTicket(t: Ticket): Promise<void> {
      await db
        .prepare(
          `INSERT INTO support_tickets (ref, topic, subject, status, name, email, order_number, order_verified, locked, meta_message_id, preview, product, thread_id, cursor,
            customer_id, customer_match, link_version, created_at, updated_at, last_customer_at, last_staff_at,
            customer_seen_at, notified_at, synced_at, closed_at,
            assignee, priority, route, tags, community_consent, community_post_id, community_cursor, community_synced_at, last_community_at)
           VALUES (${new Array(34).fill('?').join(', ')})`,
        )
        .bind(
          t.ref, t.topic, t.subject, t.status, t.name, t.email, t.orderNumber, t.orderVerified ? 1 : 0, t.locked ? 1 : 0, t.metaMessageId, t.preview, t.product, t.threadId, t.cursor,
          t.customerId, t.customerMatch, t.linkVersion, t.createdAt, t.updatedAt, t.lastCustomerAt, t.lastStaffAt,
          t.customerSeenAt, t.notifiedAt, t.syncedAt, t.closedAt,
          t.assignee, t.priority, t.route, JSON.stringify(t.tags), t.communityConsent ? 1 : 0, t.communityPostId, t.communityCursor, t.communitySyncedAt, t.lastCommunityAt,
        )
        .run();
    },

    async getTicket(ref: string): Promise<Ticket | null> {
      const row = await db.prepare('SELECT * FROM support_tickets WHERE ref = ?').bind(ref).first<TicketRow>();
      return row ? toTicket(row) : null;
    },

    async updateTicket(ref: string, patch: TicketPatch): Promise<void> {
      const keys = Object.keys(patch) as Array<keyof TicketPatch>;
      if (!keys.length) return;
      const sets = keys.map((k) => `${COLUMNS[k]} = ?`).join(', ');
      await db
        .prepare(`UPDATE support_tickets SET ${sets} WHERE ref = ?`)
        .bind(
          ...keys.map((k) => {
            const v = patch[k];
            return Array.isArray(v) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : (v ?? null);
          }),
          ref,
        )
        .run();
    },

    async ticketsByEmail(email: string, limit = 20): Promise<Ticket[]> {
      const {results} = await db
        .prepare('SELECT * FROM support_tickets WHERE email = ? ORDER BY created_at DESC LIMIT ?')
        .bind(email, limit)
        .all<TicketRow>();
      return results.map(toTicket);
    },

    async ticketsByRefs(refs: string[]): Promise<Ticket[]> {
      if (!refs.length) return [];
      const {results} = await db
        .prepare(`SELECT * FROM support_tickets WHERE ref IN (${refs.map(() => '?').join(', ')})`)
        .bind(...refs)
        .all<TicketRow>();
      return results.map(toTicket);
    },

    /**
     * Count one hit on `key` in a fixed window of `windowMs`; returns the
     * count in the current window. One statement, so concurrent isolates
     * cannot both slip under a limit.
     */
    async hit(key: string, windowMs: number, now: number): Promise<number> {
      const row = await db
        .prepare(
          `INSERT INTO support_rate (key, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT (key) DO UPDATE SET
             count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
             window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
           RETURNING count`,
        )
        .bind(key, now, now - windowMs, now - windowMs)
        .first<{count: number}>();
      return Number(row?.count ?? 1);
    },

    /**
     * A leaky bucket per key: its level drains by `drainPerMs` per ms since
     * the last change. `add` 0 reads, 1 records a miss; returns the level.
     */
    async bucket(key: string, add: number, drainPerMs: number, now: number): Promise<number> {
      if (add === 0) {
        const row = await db.prepare('SELECT level, updated_at FROM support_find_misses WHERE key = ?').bind(key).first<{level: number; updated_at: number}>();
        return row ? Math.max(0, Number(row.level) - (now - Number(row.updated_at)) * drainPerMs) : 0;
      }
      const row = await db
        .prepare(
          `INSERT INTO support_find_misses (key, level, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             level = MAX(0, level - (excluded.updated_at - updated_at) * ?) + excluded.level,
             updated_at = excluded.updated_at
           RETURNING level`,
        )
        .bind(key, add, now, drainPerMs)
        .first<{level: number}>();
      return Number(row?.level ?? add);
    },

    async pruneRate(before: number, bucketsBefore = before): Promise<void> {
      await db.prepare('DELETE FROM support_rate WHERE window_start < ?').bind(before).run();
      await db.prepare('DELETE FROM support_find_misses WHERE updated_at < ?').bind(bucketsBefore).run();
    },

    /** Tickets the cron should read from Discord: not closed, least recently synced first. */
    async ticketsToSync(activeSince: number, limit: number): Promise<Ticket[]> {
      const {results} = await db
        .prepare(
          `SELECT * FROM support_tickets WHERE status != 'closed' AND updated_at >= ?
           ORDER BY COALESCE(synced_at, 0) ASC LIMIT ?`,
        )
        .bind(activeSince, limit)
        .all<TicketRow>();
      return results.map(toTicket);
    },

    /** Answered or waiting tickets whose customer has been silent since `before`. */
    async staleTickets(before: number, limit: number): Promise<Ticket[]> {
      const {results} = await db
        .prepare(
          `SELECT * FROM support_tickets WHERE status IN ('answered', 'waiting')
           AND last_customer_at < ? AND COALESCE(last_staff_at, 0) < ? LIMIT ?`,
        )
        .bind(before, before, limit)
        .all<TicketRow>();
      return results.map(toTicket);
    },

    async expiredTickets(closedBefore: number, limit: number): Promise<Ticket[]> {
      const {results} = await db
        .prepare(`SELECT * FROM support_tickets WHERE status = 'closed' AND closed_at < ? LIMIT ?`)
        .bind(closedBefore, limit)
        .all<TicketRow>();
      return results.map(toTicket);
    },

    async deleteTicket(ref: string): Promise<void> {
      await db.batch([
        db.prepare('DELETE FROM support_notes WHERE ref = ?').bind(ref),
        db.prepare('DELETE FROM support_audit WHERE ref = ?').bind(ref),
        db.prepare('DELETE FROM support_messages WHERE ref = ?').bind(ref),
        db.prepare('DELETE FROM support_tickets WHERE ref = ?').bind(ref),
      ]);
    },

    /** Insert a message; a Discord id already stored is skipped. Returns whether it was new. */
    async addMessage(m: NewMessage): Promise<boolean> {
      const res = await db
        .prepare(
          `INSERT OR IGNORE INTO support_messages (ref, discord_id, role, author, body, attachments, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(m.ref, m.discordId, m.role, m.author, m.body, JSON.stringify(m.attachments), m.createdAt)
        .run();
      return Number(res.meta?.changes ?? 1) > 0;
    },

    async messages(ref: string, afterSeq = 0, limit = 500): Promise<TicketMessage[]> {
      const {results} = await db
        .prepare('SELECT * FROM support_messages WHERE ref = ? AND seq > ? ORDER BY created_at ASC, seq ASC LIMIT ?')
        .bind(ref, afterSeq, limit)
        .all<MessageRow>();
      return results.map(toMessage);
    },

    /** The team's replies relayed at or after `sinceDiscordId`, for re-checking edits and deletions. */
    async staffMessagesSince(ref: string, sinceDiscordId: string): Promise<TicketMessage[]> {
      const {results} = await db
        .prepare(
          `SELECT * FROM support_messages WHERE ref = ? AND role = 'staff' AND discord_id IS NOT NULL
           AND (length(discord_id) > length(?) OR (length(discord_id) = length(?) AND discord_id >= ?))`,
        )
        .bind(ref, sinceDiscordId, sinceDiscordId, sinceDiscordId)
        .all<MessageRow>();
      return results.map(toMessage);
    },

    async updateMessageBody(seq: number, body: string): Promise<void> {
      await db.prepare('UPDATE support_messages SET body = ? WHERE seq = ?').bind(body, seq).run();
    },

    async deleteMessage(seq: number): Promise<void> {
      await db.prepare('DELETE FROM support_messages WHERE seq = ?').bind(seq).run();
    },

    /** Tickets with no activity since `before`, in any status but closed. */
    async idleTickets(before: number, limit: number): Promise<Ticket[]> {
      const {results} = await db
        .prepare(`SELECT * FROM support_tickets WHERE status != 'closed' AND updated_at < ? LIMIT ?`)
        .bind(before, limit)
        .all<TicketRow>();
      return results.map(toTicket);
    },

    // ---- CRM (staff API) ----

    /** Newest activity first. `before` is an updated_at cursor. */
    async listTickets(f: TicketFilter, limit: number, before?: number): Promise<Ticket[]> {
      const where: string[] = [];
      const args: unknown[] = [];
      if (f.status?.length) {
        where.push(`status IN (${f.status.map(() => '?').join(', ')})`);
        args.push(...f.status);
      }
      if (f.route) {
        where.push('route = ?');
        args.push(f.route);
      }
      if (f.assignee === 'none') where.push('assignee IS NULL');
      else if (f.assignee) {
        where.push('assignee = ?');
        args.push(f.assignee);
      }
      if (f.priority) {
        where.push('priority = ?');
        args.push(f.priority);
      }
      if (f.topic) {
        where.push('topic = ?');
        args.push(f.topic);
      }
      if (f.tag) {
        where.push('tags LIKE ?');
        args.push(`%${JSON.stringify(f.tag).replace(/[%_\\]/g, '\\$&')}%`);
      }
      if (f.q) {
        const like = `%${f.q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`;
        where.push(`(lower(ref) LIKE ? ESCAPE '\\' OR lower(subject) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\' OR lower(preview) LIKE ? ESCAPE '\\' OR lower(COALESCE(order_number, '')) LIKE ? ESCAPE '\\')`);
        args.push(like, like, like, like, like);
      }
      if (before !== undefined) {
        where.push('updated_at < ?');
        args.push(before);
      }
      const sql = `SELECT * FROM support_tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
      const {results} = await db.prepare(sql).bind(...args, limit).all<TicketRow>();
      return results.map(toTicket);
    },

    /** Open community tickets whose forum post should be read. */
    async communityToSync(limit: number): Promise<Ticket[]> {
      const {results} = await db
        .prepare(
          `SELECT * FROM support_tickets WHERE route = 'community' AND community_post_id IS NOT NULL AND status != 'closed'
           ORDER BY COALESCE(community_synced_at, 0) ASC LIMIT ?`,
        )
        .bind(limit)
        .all<TicketRow>();
      return results.map(toTicket);
    },

    async lastMessage(ref: string): Promise<TicketMessage | null> {
      const row = await db.prepare('SELECT * FROM support_messages WHERE ref = ? ORDER BY seq DESC LIMIT 1').bind(ref).first<MessageRow>();
      return row ? toMessage(row) : null;
    },

    async messageBySeq(ref: string, seq: number): Promise<TicketMessage | null> {
      const row = await db.prepare('SELECT * FROM support_messages WHERE ref = ? AND seq = ?').bind(ref, seq).first<MessageRow>();
      return row ? toMessage(row) : null;
    },

    /** Mark one community reply as the answer (and unmark the others). False when it is not a community reply of this ticket. */
    async markAnswer(ref: string, seq: number, on: boolean): Promise<boolean> {
      const m = await db.prepare('SELECT role FROM support_messages WHERE ref = ? AND seq = ?').bind(ref, seq).first<{role: string}>();
      if (!m || m.role !== 'community') return false;
      await db.batch([
        db.prepare('UPDATE support_messages SET answer = 0 WHERE ref = ?').bind(ref),
        db.prepare('UPDATE support_messages SET answer = ? WHERE ref = ? AND seq = ?').bind(on ? 1 : 0, ref, seq),
      ]);
      return true;
    },

    async addNote(ref: string, author: string, body: string, at: number): Promise<Note> {
      const res = await db.prepare('INSERT INTO support_notes (ref, author, body, created_at) VALUES (?, ?, ?, ?)').bind(ref, author, body, at).run();
      return {id: Number(res.meta?.last_row_id ?? 0), ref, author, body, createdAt: at};
    },

    async notes(ref: string): Promise<Note[]> {
      const {results} = await db.prepare('SELECT * FROM support_notes WHERE ref = ? ORDER BY id ASC').bind(ref).all<{id: number; ref: string; author: string; body: string; created_at: number}>();
      return results.map((r) => ({id: Number(r.id), ref: r.ref, author: r.author, body: r.body, createdAt: Number(r.created_at)}));
    },

    async savedReplies(): Promise<SavedReply[]> {
      const {results} = await db.prepare('SELECT * FROM support_saved_replies ORDER BY title COLLATE NOCASE ASC').all<SavedReplyRow>();
      return results.map(toSaved);
    },

    async savedReply(id: number): Promise<SavedReply | null> {
      const row = await db.prepare('SELECT * FROM support_saved_replies WHERE id = ?').bind(id).first<SavedReplyRow>();
      return row ? toSaved(row) : null;
    },

    async createSavedReply(title: string, body: string, by: string, at: number): Promise<SavedReply> {
      const res = await db
        .prepare('INSERT INTO support_saved_replies (title, body, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .bind(title, body, by, at, at)
        .run();
      return {id: Number(res.meta?.last_row_id ?? 0), title, body, updatedBy: by, createdAt: at, updatedAt: at};
    },

    async updateSavedReply(id: number, title: string, body: string, by: string, at: number): Promise<boolean> {
      const res = await db
        .prepare('UPDATE support_saved_replies SET title = ?, body = ?, updated_by = ?, updated_at = ? WHERE id = ?')
        .bind(title, body, by, at, id)
        .run();
      return Number(res.meta?.changes ?? 0) > 0;
    },

    async deleteSavedReply(id: number): Promise<boolean> {
      const res = await db.prepare('DELETE FROM support_saved_replies WHERE id = ?').bind(id).run();
      return Number(res.meta?.changes ?? 0) > 0;
    },

    async audit(actor: string, action: string, ref: string | null, detail: string, at: number): Promise<void> {
      await db.prepare('INSERT INTO support_audit (at, actor, action, ref, detail) VALUES (?, ?, ?, ?, ?)').bind(at, actor, action, ref, detail).run();
    },

    async auditFor(ref: string, limit = 100): Promise<AuditRow[]> {
      const {results} = await db.prepare('SELECT * FROM support_audit WHERE ref = ? ORDER BY id DESC LIMIT ?').bind(ref, limit).all<AuditRow>();
      return results.map((r) => ({id: Number(r.id), at: Number(r.at), actor: r.actor, action: r.action, ref: r.ref, detail: r.detail}));
    },

    /** Audit rows without a ticket (saved replies) older than `before`. */
    async pruneAudit(before: number): Promise<void> {
      await db.prepare('DELETE FROM support_audit WHERE ref IS NULL AND at < ?').bind(before).run();
    },

    async messageByDiscordId(ref: string, discordId: string): Promise<TicketMessage | null> {
      const row = await db
        .prepare('SELECT * FROM support_messages WHERE ref = ? AND discord_id = ?')
        .bind(ref, discordId)
        .first<MessageRow>();
      return row ? toMessage(row) : null;
    },
  };
}

export type SupportStore = ReturnType<typeof createStore>;
