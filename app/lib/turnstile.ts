// Cloudflare Turnstile server-side verification. Widget posts the token,
// the Worker verifies it before creating a Discord thread.
//
// Fails CLOSED by default if the secret is missing. Local dev can opt out
// by setting SUPPORT_TURNSTILE_DEV_SKIP=1 in .env - an explicit,
// greppable flag that can't silently leak into a production deploy the
// way `process.env.NODE_ENV` can when Workerd doesn't populate it.

type Env = {
  TURNSTILE_SECRET_KEY?: string;
  SUPPORT_TURNSTILE_DEV_SKIP?: string;
};

export async function verifyTurnstile(
  env: Env,
  token: string | undefined | null,
  remoteIp?: string | null,
): Promise<{ok: boolean; reason?: string}> {
  if (!env.TURNSTILE_SECRET_KEY) {
    // The dev-skip flag is only ever honored in non-production builds.
    // `process.env.NODE_ENV` is replaced at build time by Vite, so a
    // production bundle hard-codes `false` here regardless of what
    // SUPPORT_TURNSTILE_DEV_SKIP is set to in Oxygen secrets - closes
    // the "operator accidentally pastes the dev flag into prod" hole.
    if (
      env.SUPPORT_TURNSTILE_DEV_SKIP === '1' &&
      process.env.NODE_ENV !== 'production'
    ) {
      return {ok: true, reason: 'turnstile-dev-skip'};
    }
    console.error('[turnstile] SECRET_KEY unset - failing closed');
    return {ok: false, reason: 'turnstile-misconfigured'};
  }
  if (!token) return {ok: false, reason: 'missing-token'};
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);
  try {
    const res = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {method: 'POST', body: form, signal: AbortSignal.timeout(4000)},
    );
    const data = (await res.json()) as {success: boolean; 'error-codes'?: string[]};
    return {
      ok: !!data.success,
      reason: data.success
        ? 'ok'
        : (data['error-codes']?.join(',') ?? 'verify-failed'),
    };
  } catch (err) {
    console.warn('[turnstile] verify error', err);
    return {ok: false, reason: 'verify-exception'};
  }
}
