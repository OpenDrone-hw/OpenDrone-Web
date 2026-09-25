/**
 * Test doubles for the support suites: D1 over node:sqlite with the real
 * migration, an in-memory Discord, and a scripted Shopify Admin API. Not
 * imported by application code.
 */
import {readFileSync} from 'node:fs';
import type {DiscordClient, DiscordMessage, OutboundFile} from './discord.ts';

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
  db.exec(readFileSync(new URL('../../../migrations/0001_support_tickets.sql', import.meta.url), 'utf8'));
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
  const channelPosts: Array<{channel: string; content: string}> = [];
  const reactions: Array<{thread: string; message: string; emoji: string}> = [];
  const reactorMap = new Map<string, string[]>();
  let roleMembers: string[] = [];

  function add(threadId: string, content: string, author: DiscordMessage['author'], files: OutboundFile[] = []): DiscordMessage {
    const t = threads.get(threadId);
    if (!t || t.deleted) throw Object.assign(new Error('discord post 404'), {status: 404});
    if (t.locked) throw Object.assign(new Error('discord post 403'), {status: 403});
    t.archived = false;
    const m: DiscordMessage = {
      id: nextSnowflake(),
      author,
      content,
      createdAt: new Date(now()).toISOString(),
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
      channelPosts.push({channel, content});
    },
    async messagesAfter(threadId, afterId) {
      const t = threads.get(threadId);
      if (!t || t.deleted) throw new Error('discord messages 404');
      return t.messages.filter((m) => !afterId || BigInt(m.id) > BigInt(afterId));
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
      return reactorMap.get(message) ?? [];
    },
    async roleMembers() {
      return roleMembers;
    },
  };

  return {
    client,
    threads,
    channelPosts,
    reactions,
    /** A staff member writes in a thread. */
    staff(threadId: string, content: string, who = {id: 'u1', username: 'jan', globalName: 'Jan Peeters'}) {
      return add(threadId, content, {...who, bot: false});
    },
    approve(message: DiscordMessage, userId: string, emoji = '✅') {
      message.reactions.push({emoji, count: 1, me: false});
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
