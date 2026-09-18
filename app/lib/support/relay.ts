/**
 * Outbound relay: Odoo -> Discord support thread.
 *
 * The support bridge was inbound only. A customer's message reaches Odoo
 * (api.support.start / api.support.send -> incutec_support), but a reply
 * typed into the Odoo ticket chatter reached nobody: nothing in Odoo
 * holds a Discord credential and nothing there makes an outbound call to
 * Discord. This module is the missing direction.
 *
 * Odoo does NOT get a copy of DISCORD_BOT_TOKEN. It posts to this Worker
 * with its own shared secret (SUPPORT_RELAY_SECRET) and the Worker, which
 * already holds the bot token and already has postToThread, writes the
 * message into the forum thread. One home for the bot token, one rotation
 * path, and a leaked relay secret can only append text to a support
 * thread — it cannot read and it cannot delete.
 *
 * The route handler lives here rather than in the route module so the
 * auth gate, the input validation and the support-forum check are unit
 * testable the way every other lib/support module in this repo is.
 */

import {fetchThreadChannel, postToThread} from './discord.ts';
import {constantTimeEqual} from './session.ts';
import {checkRateLimit} from '../rate-limit.ts';

export type RelayEnv = {
  SUPPORT_RELAY_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_SUPPORT_CHANNEL_ID?: string;
  DISCORD_GUILD_ID?: string;
};

export type RelayResult =
  | {ok: true; id: string}
  | {
      ok: false;
      message: string;
      code?:
        | 'not-configured'
        | 'unauthorized'
        | 'bad-request'
        | 'wrong-channel'
        | 'rate-limited'
        | 'discord';
    };

export type RelayResponse = {
  status: number;
  body: RelayResult;
  headers?: Record<string, string>;
};

// Discord snowflakes are 64-bit ids rendered as decimal. 17-20 digits
// covers every id Discord has minted and every id it can mint.
const SNOWFLAKE_RE = /^\d{17,20}$/;
// Odoo's own ticket sequence (SUP-00001). Carried for log correlation
// only; nothing is looked up by it here.
const TICKET_REF_RE = /^[A-Za-z0-9._:-]{1,40}$/;

// Same cap as api.support.send: postToThread slices at 1900 after adding
// the author prefix, so refusing above 1800 keeps a long reply from being
// silently truncated on its way out.
const MAX_BODY = 1800;
const MAX_AUTHOR = 60;

// Per-thread flood cap. A staff member typing in the Odoo chatter is
// nowhere near this; it bounds what a leaked relay secret can push into
// one thread before the isolate stops it.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 1000;

export type RelayPayload = {
  thread_id?: unknown;
  body?: unknown;
  author?: unknown;
  ticket_ref?: unknown;
};

/**
 * Strip Unicode bidi overrides and C0/C1 control chars from the author
 * label before it becomes `**<author>:**` in a public thread. postToThread
 * already does this for the message body; the prefix is built here, so it
 * needs the same treatment.
 */
export function sanitizeAuthor(raw: string): string {
  const cleaned = raw
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/[*_~`|\\]/g, '')
    .trim()
    .slice(0, MAX_AUTHOR);
  return cleaned || 'Support';
}

/**
 * Handle POST /api/support/relay. Never throws: every failure is a status
 * plus a machine-readable code, because the caller (Odoo) turns a failure
 * into an internal note on the ticket rather than an exception in a staff
 * member's face.
 */
export async function handleRelayRequest(
  env: RelayEnv,
  request: Request,
): Promise<RelayResponse> {
  if (request.method !== 'POST') {
    return {status: 405, body: {ok: false, message: 'Method not allowed.'}};
  }

  const secret = env.SUPPORT_RELAY_SECRET;
  // Unset secret, missing bot token or unconfigured forum: the endpoint
  // does not exist as far as a caller is concerned. Inert by default is
  // what makes it safe to merge before it is configured.
  if (!secret || !env.DISCORD_BOT_TOKEN || !env.DISCORD_SUPPORT_CHANNEL_ID) {
    return {
      status: 503,
      body: {
        ok: false,
        message: 'Relay endpoint not configured.',
        code: 'not-configured',
      },
    };
  }

  const auth = request.headers.get('authorization') ?? '';
  // Constant-time compare, same gate as api.support.cleanup: this bearer
  // is the only thing between the public internet and the bot posting
  // into a public forum thread, so don't leak it a byte at a time.
  if (!constantTimeEqual(auth, `Bearer ${secret}`)) {
    return {
      status: 401,
      body: {ok: false, message: 'Unauthorized.', code: 'unauthorized'},
    };
  }

  let payload: RelayPayload;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    payload = parsed as RelayPayload;
  } catch {
    return {
      status: 400,
      body: {ok: false, message: 'Invalid JSON body.', code: 'bad-request'},
    };
  }

  const threadId = typeof payload.thread_id === 'string' ? payload.thread_id.trim() : '';
  if (!SNOWFLAKE_RE.test(threadId)) {
    return {
      status: 400,
      body: {ok: false, message: 'thread_id must be a snowflake.', code: 'bad-request'},
    };
  }

  const ticketRef =
    typeof payload.ticket_ref === 'string' ? payload.ticket_ref.trim() : '';
  if (ticketRef && !TICKET_REF_RE.test(ticketRef)) {
    return {
      status: 400,
      body: {ok: false, message: 'ticket_ref is malformed.', code: 'bad-request'},
    };
  }

  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!body) {
    return {
      status: 400,
      body: {ok: false, message: 'body is required.', code: 'bad-request'},
    };
  }
  if (body.length > MAX_BODY) {
    return {
      status: 400,
      body: {
        ok: false,
        message: `body is too long (max ${MAX_BODY} chars).`,
        code: 'bad-request',
      },
    };
  }

  const author = sanitizeAuthor(
    typeof payload.author === 'string' ? payload.author : '',
  );

  const limit = checkRateLimit(`support-relay:${threadId}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!limit.allowed) {
    return {
      status: 429,
      body: {ok: false, message: 'Rate limited.', code: 'rate-limited'},
      headers: {'Retry-After': String(limit.resetInSeconds)},
    };
  }

  // The thread must be a post in the configured support forum. Without
  // this check the relay secret would let its holder make the bot speak
  // in any channel the bot can see; with it, the blast radius of a leak
  // is "append text to a support thread".
  const channel = await fetchThreadChannel(env, threadId).catch((err) => {
    console.warn('[support/relay] thread lookup failed', err);
    return null;
  });
  if (!channel || channel.parentId !== env.DISCORD_SUPPORT_CHANNEL_ID) {
    return {
      status: 403,
      body: {
        ok: false,
        message: 'thread_id is not a thread in the support forum.',
        code: 'wrong-channel',
      },
    };
  }

  // postToThread sets allowed_mentions {parse: []}, so relayed staff text
  // can never ping @everyone, a role or a member, however it is written.
  const posted = await postToThread(env, threadId, `**${author}:**\n${body}`).catch(
    (err) => {
      console.warn('[support/relay] postToThread threw', err);
      return null;
    },
  );
  if (!posted) {
    console.warn('[support/relay] post failed', ticketRef || '-', threadId);
    return {
      status: 502,
      body: {ok: false, message: 'Discord rejected the message.', code: 'discord'},
    };
  }
  return {status: 200, body: {ok: true, id: posted.id}};
}
