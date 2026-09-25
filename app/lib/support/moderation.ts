/**
 * Optional approval gate between a staff reply in Discord and the customer.
 *
 *   SUPPORT_MODERATION_MODE=enforce  a reply reaches the customer only after
 *     a holder of SUPPORT_MOD_ROLE_ID reacts with the approve emoji (default
 *     ✅). Held replies are fetched again on every sync until approved.
 *   SUPPORT_MODERATION_MODE=log      every reply is delivered; the ones
 *     enforce would hold are logged (ids and reasons only).
 *   SUPPORT_MODERATION_MODE=off      no gate.
 *
 * Unset mode means enforce when SUPPORT_MOD_ROLE_ID is set and log when it
 * is not: an empty allowlist must never silently swallow every reply.
 * Moderator ids are cached per isolate for an hour.
 */
import type {DiscordClient, DiscordMessage} from './discord.ts';

export type ModerationEnv = {
  DISCORD_GUILD_ID?: string;
  SUPPORT_MOD_ROLE_ID?: string;
  SUPPORT_APPROVE_EMOJI?: string;
  SUPPORT_MODERATION_MODE?: string;
};

export type ModerationMode = 'enforce' | 'log' | 'off';

const MOD_CACHE_TTL_MS = 60 * 60 * 1000;
const MOD_CACHE = new Map<string, {mods: Set<string>; expiresAt: number}>();

export function resolveMode(env: ModerationEnv): ModerationMode {
  const raw = env.SUPPORT_MODERATION_MODE?.trim().toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'log') return 'log';
  if (!env.SUPPORT_MOD_ROLE_ID) return 'log';
  return 'enforce';
}

export function approveEmoji(env: ModerationEnv): string {
  return env.SUPPORT_APPROVE_EMOJI?.trim() || '✅';
}

export function _resetModCache(): void {
  MOD_CACHE.clear();
}

async function moderatorIds(env: ModerationEnv, discord: DiscordClient): Promise<Set<string>> {
  if (!env.DISCORD_GUILD_ID || !env.SUPPORT_MOD_ROLE_ID) return new Set();
  const key = `${env.DISCORD_GUILD_ID}:${env.SUPPORT_MOD_ROLE_ID}`;
  const hit = MOD_CACHE.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.mods;
  const mods = new Set(await discord.roleMembers(env.SUPPORT_MOD_ROLE_ID));
  MOD_CACHE.set(key, {mods, expiresAt: Date.now() + MOD_CACHE_TTL_MS});
  return mods;
}

export type Decision = {approved: boolean; reason: string};

export async function decide(
  env: ModerationEnv,
  discord: DiscordClient,
  threadId: string,
  message: DiscordMessage,
): Promise<Decision> {
  const mode = resolveMode(env);
  if (mode === 'off') return {approved: true, reason: 'off'};
  const emoji = approveEmoji(env);
  const hint = message.reactions.find((r) => r.emoji === emoji);
  const verdict: Decision = await (async () => {
    if (!hint || hint.count <= 0) return {approved: false, reason: 'no-reaction'};
    const mods = await moderatorIds(env, discord);
    if (!mods.size) return {approved: true, reason: 'no-moderators-resolved'};
    const reactors = await discord.reactors(threadId, message.id, emoji);
    return reactors.some((id) => mods.has(id))
      ? {approved: true, reason: 'approved'}
      : {approved: false, reason: 'no-moderator-reaction'};
  })();
  if (!verdict.approved && mode === 'log') {
    console.warn('[support] moderation log-mode would hold', message.id, verdict.reason);
    return {approved: true, reason: `log:${verdict.reason}`};
  }
  return verdict;
}

/**
 * The cursor to store after a sync: the newest message, unless a reply is
 * held, in which case the cursor parks just before the earliest held one so
 * the next sync sees it again once it is approved.
 */
export function cursorAfter(
  messages: Array<{id: string}>,
  heldIds: Set<string>,
  lastCursor: string | null,
): string | null {
  const newest = messages.length ? messages[messages.length - 1]!.id : null;
  if (!heldIds.size) return newest ?? lastCursor;
  const first = messages.findIndex((m) => heldIds.has(m.id));
  if (first <= 0) return lastCursor;
  return messages[first - 1]!.id;
}
