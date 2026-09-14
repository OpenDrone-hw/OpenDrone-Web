const profile = process.argv[2];
const required = profile === 'production'
  ? [
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
    ]
  : profile === 'preview'
    ? ['SESSION_SECRET']
    : [];

if (!required.length) {
  console.error('usage: check-runtime-env.mjs preview|production');
  process.exit(2);
}
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`Missing ${profile} runtime variables: ${missing.join(', ')}`);
  process.exit(1);
}
process.stdout.write(`${profile} runtime variable names are complete (${required.length})\n`);
