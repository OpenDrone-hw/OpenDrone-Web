/**
 * Test doubles for the support suites: D1 over node:sqlite with the real
 * migration, an in-memory Discord, and a scripted Shopify Admin API. Not
 * imported by application code.
 */
import {readdirSync, readFileSync} from 'node:fs';
import type {AskContext, ChatFpvClient} from './chatfpv.ts';
import type {ChatAnswer, DraftOutcomeRequest, DraftRequest, DraftResponse} from './chatfpv-contract.ts';
import {DiscordError, type DiscordClient, type DiscordMessage, type OutboundFile} from './discord.ts';

type SqliteDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): {changes: number | bigint; lastInsertRowid: number | bigint};
  };
};

/** node:sqlite (Node 22.13+). Null when unavailable, so suites can skip. */
export async function openSqlite(): Promise<SqliteDb | null> {
  try {
    const mod = (await import('node:sqlite')) as unknown as {DatabaseSync: new (path: string) => SqliteDb};
    return new mod.DatabaseSync(':memory:');
  } catch {
    return null;
  }
}

/** A D1Database backed by sqlite with migrations/*.sql applied. */
export async function testD1(): Promise<D1Database | null> {
  const opened = await openSqlite();
  if (!opened) return null;
  const db = opened;
  const dir = new URL('../../../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const norm = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
  function statement(sql: string, params: unknown[] = []): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => statement(sql, values.map(norm)),
      first: async <T,>() => ((db.prepare(sql).get(...params) as T | undefined) ?? null),
      all: async <T,>() => ({results: db.prepare(sql).all(...params) as T[], success: true, meta: {}}),
      run: async () => {
        const r = db.prepare(sql).run(...params);
        return {results: [], success: true, meta: {changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid)}};
      },
    };
  }
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (stmts: D1PreparedStatement[]) => Promise.all(stmts.map((s) => s.run())),
  };
}

type FakeThread = {
  id: string;
  name: string;
  archived: boolean;
  locked: boolean;
  deleted: boolean;
  messages: DiscordMessage[];
};

let snowflake = 1_000_000_000_000_000_000n;
export function nextSnowflake(): string {
  snowflake += 1000n;
  return snowflake.toString();
}

/** An in-memory Discord with the DiscordClient surface. */
export function fakeDiscord(opts: {failCreate?: boolean; now?: () => number} = {}) {
  const now = opts.now ?? Date.now;
  const threads = new Map<string, FakeThread>();
  const channelPosts: Array<{channel: string; content: string; id: string; deleted: boolean}> = [];
  const reactions: Array<{thread: string; message: string; emoji: string}> = [];
  const reactorMap = new Map<string, string[]>();
  let roleMembers: string[] = [];
  const botUsers = new Set<string>();
  const lookups = {reactors: 0};

  function add(threadId: string, content: string, author: DiscordMessage['author'], files: OutboundFile[] = []): DiscordMessage {
    const t = threads.get(threadId);
    if (!t || t.deleted) throw new DiscordError('post', 404);
    if (t.locked) throw new DiscordError('post', 403);
    t.archived = false;
    const m: DiscordMessage = {
      id: nextSnowflake(),
      author,
      content,
      createdAt: new Date(now()).toISOString(),
      editedAt: null,
      attachments: files.map((f) => ({id: nextSnowflake(), url: `https://cdn.example/${f.name}`, filename: f.name, size: f.data.byteLength})),
      reactions: [],
    };
    t.messages.push(m);
    return m;
  }
  const bot = {id: 'bot', username: 'OpenDrone', globalName: null, bot: true};

  const client: DiscordClient = {
    async createThread({name, card}) {
      if (opts.failCreate) throw new Error('discord createThread 500');
      const id = nextSnowflake();
      threads.set(id, {id, name, archived: false, locked: false, deleted: false, messages: []});
      add(id, card, bot);
      return id;
    },
    async post(threadId, content, files = []) {
      return add(threadId, content, bot, files).id;
    },
    async postToChannel(channel, content) {
      const id = nextSnowflake();
      channelPosts.push({channel, content, id, deleted: false});
      return id;
    },
    async deleteMessage(channel, messageId) {
      const post = channelPosts.find((p) => p.channel === channel && p.id === messageId);
      if (post) post.deleted = true;
      const m = threads.get(channel)?.messages;
      if (m) threads.get(channel)!.messages = m.filter((x) => x.id !== messageId);
    },
    async messagesAfter(threadId, afterId, limit = 100) {
      const t = threads.get(threadId);
      if (!t || t.deleted) throw new Error('discord messages 404');
      // Like Discord: with `after`, the oldest `limit` after it; without, the newest `limit`.
      return afterId
        ? t.messages.filter((m) => BigInt(m.id) > BigInt(afterId)).slice(0, limit)
        : t.messages.slice(-limit);
    },
    async message(threadId, messageId) {
      const m = threads.get(threadId)?.messages.find((x) => x.id === messageId);
      if (!m) throw new Error('discord message 404');
      return m;
    },
    async thread(threadId) {
      const t = threads.get(threadId);
      if (!t || t.deleted) return null;
      return {id: t.id, archived: t.archived, locked: t.locked};
    },
    async setArchived(threadId, archived) {
      const t = threads.get(threadId);
      if (t) t.archived = archived;
    },
    async deleteThread(threadId) {
      const t = threads.get(threadId);
      if (t) t.deleted = true;
    },
    async react(thread, message, emoji) {
      reactions.push({thread, message, emoji});
    },
    async reactors(_thread, message) {
      lookups.reactors++;
      // Like the real client: bot accounts are dropped.
      return (reactorMap.get(message) ?? []).filter((id) => !botUsers.has(id));
    },
    async hasRole(userId) {
      return roleMembers.includes(userId);
    },
  };

  return {
    client,
    threads,
    channelPosts,
    reactions,
    lookups,
    /** A staff member writes in a thread. */
    staff(threadId: string, content: string, who = {id: 'u1', username: 'jan', globalName: 'Jan Peeters'}) {
      return add(threadId, content, {...who, bot: false});
    },
    /** A staff member edits or deletes a message already in the thread. */
    edit(threadId: string, messageId: string, content: string) {
      const m = threads.get(threadId)!.messages.find((x) => x.id === messageId)!;
      m.content = content;
      m.editedAt = new Date(now()).toISOString();
    },
    remove(threadId: string, messageId: string) {
      const t = threads.get(threadId)!;
      t.messages = t.messages.filter((x) => x.id !== messageId);
    },
    /** A reaction by `userId`; `bot` marks a bot account, `self` the support bot itself. */
    approve(message: DiscordMessage, userId: string, emoji = '✅', opts: {bot?: boolean; self?: boolean} = {}) {
      if (opts.bot || opts.self) botUsers.add(userId);
      const r = message.reactions.find((x) => x.emoji === emoji);
      if (r) {
        r.count += 1;
        if (opts.self) r.me = true;
      } else message.reactions.push({emoji, count: 1, me: Boolean(opts.self)});
      reactorMap.set(message.id, [...(reactorMap.get(message.id) ?? []), userId]);
    },
    setRoleMembers(ids: string[]) {
      roleMembers = ids;
    },
  };
}

export type ShopifyScript = {
  customers?: Array<{id: string; email: string; numberOfOrders?: number; orders?: unknown[]; metafield?: {value: string} | null}>;
  orders?: Array<Record<string, unknown>>;
};

/** A Shopify Admin GraphQL endpoint answering from `script`, recording mutations. */
export function fakeShopify(script: ShopifyScript) {
  const writes: Array<{op: string; variables: Record<string, unknown>}> = [];
  const metafields = new Map<string, string>();
  for (const c of script.customers ?? []) if (c.metafield?.value) metafields.set(c.id, c.metafield.value);
  const fetcher = (async (_url: string, init: RequestInit) => {
    const {query, variables} = JSON.parse(String(init.body)) as {query: string; variables: Record<string, unknown>};
    const json = (data: unknown) => new Response(JSON.stringify({data}), {status: 200});
    if (query.includes('SupportCustomer')) {
      const q = String(variables.q);
      const needle = q.replace(/^email:"|"$/g, '').toLowerCase();
      // Shopify search is fuzzy: return every customer whose email contains the needle's local part.
      const local = needle.split('@')[0]!;
      const nodes = (script.customers ?? [])
        .filter((c) => c.email.toLowerCase().includes(local))
        .map((c) => ({...c, metafield: metafields.has(c.id) ? {value: metafields.get(c.id)} : null, orders: {nodes: c.orders ?? []}}));
      return json({customers: {nodes}});
    }
    if (query.includes('SupportOrder')) {
      const name = String(variables.q).replace(/^name:"|"$/g, '');
      return json({orders: {nodes: (script.orders ?? []).filter((o) => o.name === name)}});
    }
    if (query.includes('SupportTicketsRead')) {
      const id = String(variables.id);
      return json({customer: {metafield: metafields.has(id) ? {value: metafields.get(id)} : null}});
    }
    if (query.includes('SupportTickets(')) {
      const mf = (variables.metafields as Array<{ownerId: string; value: string}>)[0]!;
      metafields.set(mf.ownerId, mf.value);
      writes.push({op: 'metafieldsSet', variables});
      return json({metafieldsSet: {userErrors: []}});
    }
    if (query.includes('SupportTag')) {
      writes.push({op: 'tagsAdd', variables});
      return json({tagsAdd: {userErrors: []}});
    }
    return new Response('unknown', {status: 400});
  }) as unknown as typeof fetch;
  return {fetcher, writes, metafields};
}

/**
 * A ChatFPV client that records every call. `draft` answers from `opts.draft`
 * (default: a short grounded draft); `failOutcome` makes outcome posts fail
 * (null), as a timeout or 5xx would.
 */
export function fakeChatFpv(opts: {draft?: (req: DraftRequest, n: number) => DraftResponse | null; answer?: ChatAnswer | null; failOutcome?: boolean} = {}) {
  const drafts: DraftRequest[] = [];
  const outcomes: DraftOutcomeRequest[] = [];
  const asks: Array<{message: string; context?: AskContext}> = [];
  const state = {failOutcome: opts.failOutcome ?? false};
  const client: ChatFpvClient = {
    async draft(req) {
      drafts.push(req);
      if (opts.draft) return opts.draft(req, drafts.length);
      return {
        draftId: `dr_${drafts.length}`,
        draft: 'Flash the latest firmware with the configurator, then recalibrate the gyro [1].',
        citations: [{n: 1, title: 'Flashing', url: 'https://docs.opendrone.be/flash', source: 'OpenDrone docs', kind: 'doc'}],
        confidence: 0.82,
        note: 'grounded in the OpenDrone docs',
      };
    },
    async outcome(req) {
      outcomes.push(req);
      return state.failOutcome ? null : true;
    },
    async ask(message, context) {
      asks.push({message, context});
      return opts.answer ?? null;
    },
  };
  return {client, drafts, outcomes, asks, state};
}
