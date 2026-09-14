export const PRODUCTION_RUNTIME_VARIABLES = [
  'SESSION_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_SUPPORT_CHANNEL_ID',
  'DISCORD_GUILD_ID',
  'DISCORD_STAFF_METADATA_CHANNEL_ID',
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
  'RESEND_API_KEY',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SUPPORT_ODOO_TOKEN',
  'SUPPORT_CLEANUP_SECRET',
  'GITHUB_STATUS_TOKEN',
] as const;

export class RuntimeConfigurationError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`Missing runtime variables: ${missing.join(', ')}`);
    this.missing = missing;
    this.name = 'RuntimeConfigurationError';
  }
}

export function assertRuntimeEnvironment(env: Env): void {
  const required = env.RUNTIME_PROFILE === 'production'
    ? PRODUCTION_RUNTIME_VARIABLES
    : (['SESSION_SECRET'] as const);
  const missing = required.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length) throw new RuntimeConfigurationError([...missing]);
}
