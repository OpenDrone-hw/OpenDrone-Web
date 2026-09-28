/**
 * Operational alerts to the staff-only Discord channel
 * (`DISCORD_STAFF_METADATA_CHANNEL_ID`), through the support Discord client
 * (app/lib/support/discord.ts `postToChannel`, the bot that already posts
 * ticket metadata there). An alert fires only where `OPS_ALERTS_ENABLED` is
 * "1", which only `wrangler.production.toml` sets, and at most once per UTC
 * day per key: the key and day are claimed in D1 (`ops_alerts`) before the
 * post. Alert text carries counts and request ids, never personal data.
 * Never throws: a broken alert path must not break the caller.
 */
import {createDiscordClient, type DiscordEnv} from './support/discord.ts';

export type OpsAlertEnv = DiscordEnv & {
  SUPPORT_DB?: D1Database;
  OPS_ALERTS_ENABLED?: string;
};

export type AlertPoster = (channelId: string, text: string) => Promise<unknown>;

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Posts `text` once per UTC day for `key`. Returns true when this call posted. */
export async function opsAlertOnce(env: OpsAlertEnv, key: string, text: string, now = Date.now(), post?: AlertPoster): Promise<boolean> {
  console.error(`[ops-alert] ${key}: ${text}`);
  if (env.OPS_ALERTS_ENABLED?.trim() !== '1') return false;
  const db = env.SUPPORT_DB;
  const channel = env.DISCORD_STAFF_METADATA_CHANNEL_ID?.trim();
  if (!db || !channel || (!post && !env.DISCORD_BOT_TOKEN)) return false;
  try {
    const claim = await db
      .prepare('INSERT INTO ops_alerts (alert_key, day, sent_at) VALUES (?, ?, ?) ON CONFLICT (alert_key, day) DO NOTHING')
      .bind(key, utcDay(now), now)
      .run();
    if (!claim.meta?.changes) return false;
    const send: AlertPoster = post ?? ((id, content) => createDiscordClient(env).postToChannel(id, content));
    await send(channel, `[${key}] ${text}`);
    return true;
  } catch (err) {
    console.error('[ops-alert] not sent', err instanceof Error ? err.message : 'error');
    return false;
  }
}

/** Alert claims older than 30 days are only noise. */
export async function purgeOpsAlerts(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM ops_alerts WHERE sent_at < ?').bind(now - 30 * 24 * 60 * 60 * 1000).run();
}
