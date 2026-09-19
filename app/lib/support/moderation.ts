// Moderation gate for the Discord -> web-support bridge (Stage 2).
//
// Every raw Discord message that the poll route surfaces to the browser
// passes through `scrubForPublic` (Stage 1) AND this gate. A message is
// only delivered to the customer when an allowlisted moderator has
// reacted to it with the approve emoji (default: "✅").
//
// The moderator allowlist is the set of users in the configured Discord
// guild who carry the `SUPPORT_MOD_ROLE_ID` role. It's cached per
// Worker isolate for 1 hour - a fresh fetch would cost one API call
// per poll, which is wasteful when the role membership changes weekly.
//
// Rollback / staged rollout:
//   SUPPORT_MODERATION_MODE=enforce (default): only approved messages
//     reach the customer; everything else is dropped silently.
//   SUPPORT_MODERATION_MODE=log: everything reaches the customer (legacy
//     behaviour), but we log which messages *would* have been held so
//     staff can watch the gate before flipping it on.
//   SUPPORT_MODERATION_MODE=off: gate disabled, no logging. Use this
//     only during an incident.
//
// If SUPPORT_MOD_ROLE_ID is unset, the gate falls back to `log` mode
// regardless of SUPPORT_MODERATION_MODE - better than silently
// enforcing an empty allowlist (which would drop every message).

import type {DiscordMessage} from './discord.ts';
import {fetchGuildRoleMembers, fetchReactors} from './discord.ts';

export type ModerationEnv = {
  DISCORD_BOT_TOKEN?: string;
  DISCORD_SUPPORT_CHANNEL_ID?: string;
  DISCORD_GUILD_ID?: string;
  SUPPORT_MOD_ROLE_ID?: string;
  SUPPORT_APPROVE_EMOJI?: string;
  SUPPORT_MODERATION_MODE?: string;
};

export type ModerationMode = 'enforce' | 'log' | 'off';

export type ApprovalDecision =
  | {approved: true; reason: 'mod-reacted' | 'bypass-off' | 'bypass-unconfigured'}
  | {approved: false; reason: 'no-reaction' | 'no-mod-reacted'};

const DEFAULT_APPROVE_EMOJI = '✅';
const MOD_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type ModCache = {
  mods: Set<string>;
  expiresAt: number;
};

// One cache per guild id, scoped to this isolate. Cloudflare Workers
// run many isolates per PoP - that's fine, each warms its own cache
// lazily. Worst case is N roundtrips across N cold isolates per hour.
const MOD_CACHE = new Map<string, ModCache>();

export function resolveMode(env: ModerationEnv): ModerationMode {
  const raw = env.SUPPORT_MODERATION_MODE?.toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'log') return 'log';
  // Fall back to log when the role isn't configured - we'd rather leak
  // by default than silently drop every message because an env var is
  // missing. Enforce only kicks in once the role id is wired up.
  if (!env.SUPPORT_MOD_ROLE_ID) return 'log';
  return 'enforce';
}

export function approveEmoji(env: ModerationEnv): string {
  const v = env.SUPPORT_APPROVE_EMOJI?.trim();
  return v && v.length > 0 ? v : DEFAULT_APPROVE_EMOJI;
}

// Returns the set of user ids that hold the moderator role, from cache
// or by re-fetching. Visible to tests so they can prime the cache.
export async function getModeratorIds(
  env: ModerationEnv,
): Promise<Set<string>> {
  if (!env.DISCORD_GUILD_ID || !env.SUPPORT_MOD_ROLE_ID) {
    return new Set();
  }
  const key = `${env.DISCORD_GUILD_ID}:${env.SUPPORT_MOD_ROLE_ID}`;
  const cached = MOD_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.mods;
  }
  const ids = await fetchGuildRoleMembers(env, env.SUPPORT_MOD_ROLE_ID);
  const mods = new Set(ids);
  MOD_CACHE.set(key, {mods, expiresAt: Date.now() + MOD_CACHE_TTL_MS});
  return mods;
}

// Visible-to-tests helper to clear the cache between runs.
export function _resetModCache(): void {
  MOD_CACHE.clear();
}

// Decide whether a given Discord message has been approved for
// publication to the customer. The `emoji` argument is the approve
// emoji; the decision does not fetch reactors unless the message's own
// `reactions` array reports at least one user reacted with that emoji.
export async function decideApproval(
  env: ModerationEnv,
  message: DiscordMessage,
  channelId: string,
): Promise<ApprovalDecision> {
  const mode = resolveMode(env);
  if (mode === 'off') {
    return {approved: true, reason: 'bypass-off'};
  }
  // No role configured - `resolveMode` already forces 'log'. We still
  // compute the real decision so the log output can tell staff what
  // would happen under enforce.
  const emoji = approveEmoji(env);
  const reactionHint = message.reactions.find((r) => r.emoji === emoji);
  if (!reactionHint || reactionHint.count <= 0) {
    return {approved: false, reason: 'no-reaction'};
  }
  const modIds = await getModeratorIds(env);
  if (modIds.size === 0) {
    // No resolvable mods - treat as bypass so the system keeps working
    // while staff figure out the role config.
    return {approved: true, reason: 'bypass-unconfigured'};
  }
  const reactors = await fetchReactors(env, channelId, message.id, emoji);
  const approvedByMod = reactors.some((id) => modIds.has(id));
  return approvedByMod
    ? {approved: true, reason: 'mod-reacted'}
    : {approved: false, reason: 'no-mod-reacted'};
}

// Top-level filter used by the poll route. Returns the subset of
// messages that should reach the customer. Pure function apart from
// the fetch() calls buried in decideApproval. Returns the decisions
// alongside the kept messages so the caller can log the dropped set
// without re-computing.
export type FilterResult = {
  approved: DiscordMessage[];
  dropped: Array<{message: DiscordMessage; reason: string}>;
  mode: ModerationMode;
};

export async function filterByApproval(
  env: ModerationEnv,
  messages: DiscordMessage[],
  channelId: string,
): Promise<FilterResult> {
  const mode = resolveMode(env);
  if (mode === 'off') {
    return {approved: messages, dropped: [], mode};
  }
  // decideApproval may do a per-message Discord `fetchReactors` round-trip.
  // Resolve them in parallel so the poll waits one round-trip's latency, not
  // N sequential ones, then assemble in input order to keep message ordering.
  const decisions = await Promise.all(
    messages.map((m) => decideApproval(env, m, channelId)),
  );
  const approved: DiscordMessage[] = [];
  const dropped: Array<{message: DiscordMessage; reason: string}> = [];
  messages.forEach((m, i) => {
    const d = decisions[i];
    if (d.approved) {
      approved.push(m);
    } else if (mode === 'log') {
      // Under log mode, deliver everything but record what would be
      // held under enforce. Staff can watch a dashboard / log stream
      // to decide when the gate is trained well enough to flip on.
      approved.push(m);
      dropped.push({message: m, reason: d.reason});
    } else {
      dropped.push({message: m, reason: d.reason});
    }
  });
  return {approved, dropped, mode};
}
