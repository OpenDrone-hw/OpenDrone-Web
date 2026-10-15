/**
 * The two CRM switches. Both are `[vars]`, off by default; merging code that
 * uses them changes nothing live until the founder turns them on.
 */
export type CrmFlagEnv = {
  SUPPORT_CRM_API?: string;
  SUPPORT_COMMUNITY_ROUTE?: string;
  DISCORD_HELP_CHANNEL_ID?: string;
  DISCORD_BOT_TOKEN?: string;
};

/** The staff API answers, team tickets open no Discord staff thread, attachments go to R2. */
export function crmEnabled(env: CrmFlagEnv): boolean {
  return env.SUPPORT_CRM_API === '1';
}

/** Consenting customers' community-labelled questions are posted to the public help forum. */
export function communityEnabled(env: CrmFlagEnv): boolean {
  return crmEnabled(env) && env.SUPPORT_COMMUNITY_ROUTE === '1' && Boolean(env.DISCORD_HELP_CHANNEL_ID) && Boolean(env.DISCORD_BOT_TOKEN);
}

/** A ticket opened while the CRM was on has no Discord staff thread (`thread_id` is ''). */
export function hasThread(t: {threadId: string}): boolean {
  return t.threadId !== '';
}
