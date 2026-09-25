/**
 * The Discord side of support: a bot-authenticated REST client, no gateway.
 * A Worker cannot hold a WebSocket, and support volume is small enough for
 * the Worker to read a ticket's thread when the ticket page asks and on the
 * five-minute cron.
 *
 * Each ticket is one thread under DISCORD_SUPPORT_CHANNEL_ID: a private
 * thread when that channel is a text channel (only members added to it, the
 * support role and people with Manage Threads see it), or a post when it is
 * a forum channel (visible to whoever can see the forum, so keep that forum
 * staff-only).
 *
 * `fetch` is injectable so tests run against a fake Discord.
 */

export const DISCORD_API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 6000;
const USER_AGENT = 'opendrone-support (https://opendrone.be, 2)';

export type DiscordEnv = {
  DISCORD_BOT_TOKEN?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_SUPPORT_CHANNEL_ID?: string;
  DISCORD_STAFF_METADATA_CHANNEL_ID?: string;
  SUPPORT_MOD_ROLE_ID?: string;
  SUPPORT_DEV_DISCORD_API?: string;
};

export type DiscordMessage = {
  id: string;
  author: {id: string; username: string; globalName: string | null; bot: boolean};
  content: string;
  createdAt: string;
  attachments: Array<{id: string; url: string; filename: string; size: number}>;
  reactions: Array<{emoji: string; count: number; me: boolean}>;
};

export type DiscordThread = {id: string; archived: boolean; locked: boolean};

export type OutboundFile = {name: string; type: string; data: ArrayBuffer | Uint8Array};

type Fetcher = typeof fetch;

export class DiscordError extends Error {
  status: number;
  constructor(what: string, status: number) {
    super(`discord ${what} ${status}`);
    this.status = status;
  }
}

/** The dev server may point at a local stub; a build always talks to Discord. */
export function discordApiBase(env: DiscordEnv): string {
  const dev = typeof import.meta.env !== 'undefined' && import.meta.env.DEV;
  if (dev && env.SUPPORT_DEV_DISCORD_API) return env.SUPPORT_DEV_DISCORD_API.replace(/\/+$/, '');
  return DISCORD_API;
}

export function discordConfigured(env: DiscordEnv): boolean {
  return Boolean(env.DISCORD_BOT_TOKEN && env.DISCORD_SUPPORT_CHANNEL_ID);
}

/** Jump link staff can open from Shopify or the metadata channel. */
export function threadUrl(env: DiscordEnv, threadId: string): string {
  return `https://discord.com/channels/${env.DISCORD_GUILD_ID || '@me'}/${threadId}`;
}

// Bidi overrides and C0/C1 controls (tab and newline kept): the Trojan
// Source class of trick that reverses what staff see in a message.
const BIDI = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069]', 'g');
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]', 'g');

export function cleanText(s: string): string {
  return s.replace(BIDI, '').replace(CONTROL, '');
}

export function sanitizeFilename(name: string): string {
  const cleaned = cleanText(name).replace(/[\\/]/g, '_').slice(0, 100);
  return cleaned || 'file';
}

/**
 * Split text into Discord-sized chunks (2000 is the hard cap), on line
 * breaks where possible so a pasted log stays readable.
 */
export function chunkMessage(text: string, max = 1900): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length || !out.length) out.push(rest);
  return out;
}

type RawMessage = {
  id: string;
  content?: string;
  timestamp: string;
  author: {id: string; username: string; global_name?: string | null; bot?: boolean};
  attachments?: Array<{id: string; url: string; filename: string; size?: number}>;
  reactions?: Array<{emoji?: {name?: string | null}; count?: number; me?: boolean}>;
};

export function normalizeMessage(raw: unknown): DiscordMessage {
  const m = raw as RawMessage;
  return {
    id: m.id,
    content: m.content ?? '',
    createdAt: m.timestamp,
    author: {
      id: m.author.id,
      username: m.author.username,
      globalName: m.author.global_name ?? null,
      bot: Boolean(m.author.bot),
    },
    attachments: (m.attachments ?? []).map((a) => ({
      id: a.id,
      url: a.url,
      filename: a.filename,
      size: a.size ?? 0,
    })),
    reactions: (m.reactions ?? [])
      .map((r) => ({emoji: r.emoji?.name ?? '', count: r.count ?? 0, me: Boolean(r.me)}))
      .filter((r) => r.emoji.length > 0),
  };
}

export type DiscordClient = ReturnType<typeof createDiscordClient>;

export function createDiscordClient(env: DiscordEnv, fetcher: Fetcher = fetch) {
  const base = discordApiBase(env);

  function headers(json: boolean): Record<string, string> {
    if (!env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN not set');
    const h: Record<string, string> = {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      'User-Agent': USER_AGENT,
    };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async function call(what: string, path: string, init: {method?: string; body?: unknown; files?: OutboundFile[]} = {}) {
    const files = init.files ?? [];
    let body: BodyInit | undefined;
    if (files.length) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(init.body ?? {}));
      files.forEach((f, i) => {
        const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
        form.append(`files[${i}]`, new Blob([bytes as Uint8Array<ArrayBuffer>], {type: f.type || 'application/octet-stream'}), sanitizeFilename(f.name));
      });
      body = form;
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
    }
    const res = await fetcher(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: headers(!files.length && init.body !== undefined),
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new DiscordError(what, res.status);
    if (res.status === 204) return null;
    return res.json() as Promise<unknown>;
  }

  // Channel type per isolate: 0 text, 15 forum.
  let supportChannelType: number | null = null;

  async function channelType(): Promise<number> {
    if (supportChannelType !== null) return supportChannelType;
    const ch = (await call('getChannel', `/channels/${env.DISCORD_SUPPORT_CHANNEL_ID}`)) as {type: number};
    supportChannelType = ch.type;
    return ch.type;
  }

  return {
    /**
     * Open the ticket thread with its first (staff card) message. Returns the
     * thread id. In a text channel the thread is private and not invitable;
     * mentioning the support role in the card adds that role to it.
     */
    async createThread(opts: {name: string; card: string}): Promise<string> {
      const channel = env.DISCORD_SUPPORT_CHANNEL_ID;
      if (!channel) throw new Error('DISCORD_SUPPORT_CHANNEL_ID not set');
      const name = cleanText(opts.name).slice(0, 96);
      const mentions = env.SUPPORT_MOD_ROLE_ID ? {parse: [], roles: [env.SUPPORT_MOD_ROLE_ID]} : {parse: []};
      const card = cleanText(opts.card).slice(0, 1990);
      const type = await channelType();
      if (type === 15) {
        const thread = (await call('createForumPost', `/channels/${channel}/threads`, {
          method: 'POST',
          body: {name, auto_archive_duration: 10080, message: {content: card, allowed_mentions: mentions}},
        })) as {id: string};
        return thread.id;
      }
      const thread = (await call('createThread', `/channels/${channel}/threads`, {
        method: 'POST',
        body: {name, type: 12, invitable: false, auto_archive_duration: 10080},
      })) as {id: string};
      await call('postCard', `/channels/${thread.id}/messages`, {
        method: 'POST',
        body: {content: card, allowed_mentions: mentions},
      });
      return thread.id;
    },

    /** Post into a thread. Never pings anyone. Returns the message id. */
    async post(threadId: string, content: string, files: OutboundFile[] = []): Promise<string> {
      const msg = (await call('post', `/channels/${threadId}/messages`, {
        method: 'POST',
        body: {content: cleanText(content).slice(0, 2000), allowed_mentions: {parse: []}},
        files,
      })) as {id: string};
      return msg.id;
    },

    async postToChannel(channelId: string, content: string): Promise<void> {
      await call('postChannel', `/channels/${channelId}/messages`, {
        method: 'POST',
        body: {content: cleanText(content).slice(0, 2000), allowed_mentions: {parse: []}},
      });
    },

    /** Messages newer than `afterId`, oldest first (Discord answers newest first). */
    async messagesAfter(threadId: string, afterId: string | null, limit = 100): Promise<DiscordMessage[]> {
      const params = new URLSearchParams({limit: String(Math.min(limit, 100))});
      if (afterId) params.set('after', afterId);
      const raw = (await call('messages', `/channels/${threadId}/messages?${params}`)) as unknown[];
      const list = Array.isArray(raw) ? raw.map(normalizeMessage) : [];
      return list.sort((a, b) => compareSnowflakes(a.id, b.id));
    },

    async message(threadId: string, messageId: string): Promise<DiscordMessage> {
      return normalizeMessage(await call('message', `/channels/${threadId}/messages/${messageId}`));
    },

    async thread(threadId: string): Promise<DiscordThread | null> {
      try {
        const t = (await call('thread', `/channels/${threadId}`)) as {
          id: string;
          thread_metadata?: {archived?: boolean; locked?: boolean};
        };
        return {id: t.id, archived: Boolean(t.thread_metadata?.archived), locked: Boolean(t.thread_metadata?.locked)};
      } catch (err) {
        if (err instanceof DiscordError && err.status === 404) return null;
        throw err;
      }
    },

    async setArchived(threadId: string, archived: boolean): Promise<void> {
      await call('archive', `/channels/${threadId}`, {method: 'PATCH', body: {archived}});
    },

    /** Delete a thread; already gone counts as done. */
    async deleteThread(threadId: string): Promise<void> {
      try {
        await call('delete', `/channels/${threadId}`, {method: 'DELETE'});
      } catch (err) {
        if (err instanceof DiscordError && err.status === 404) return;
        throw err;
      }
    },

    async react(threadId: string, messageId: string, emoji: string): Promise<void> {
      await call('react', `/channels/${threadId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
        method: 'PUT',
      });
    },

    async reactors(threadId: string, messageId: string, emoji: string): Promise<string[]> {
      try {
        const raw = (await call(
          'reactors',
          `/channels/${threadId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=25`,
        )) as Array<{id?: string}>;
        return Array.isArray(raw) ? raw.map((u) => u.id ?? '').filter(Boolean) : [];
      } catch (err) {
        if (err instanceof DiscordError && err.status === 404) return [];
        throw err;
      }
    },

    /** User ids holding a role (paged, capped at 1000 members). */
    async roleMembers(roleId: string): Promise<string[]> {
      if (!env.DISCORD_GUILD_ID) return [];
      const ids: string[] = [];
      let after = '';
      for (let page = 0; page < 10; page++) {
        const raw = (await call(
          'members',
          `/guilds/${env.DISCORD_GUILD_ID}/members?limit=100${after ? `&after=${after}` : ''}`,
        )) as Array<{user?: {id?: string}; roles?: string[]}>;
        if (!Array.isArray(raw) || !raw.length) break;
        for (const m of raw) if (m.user?.id && m.roles?.includes(roleId)) ids.push(m.user.id);
        if (raw.length < 100) break;
        after = raw[raw.length - 1]?.user?.id ?? '';
        if (!after) break;
      }
      return ids;
    },
  };
}

/** Snowflakes are decimal strings; compare by length, then lexically. */
export function compareSnowflakes(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
