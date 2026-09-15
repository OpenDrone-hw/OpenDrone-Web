/**
 * Odoo newsletter signup bridge (erp PLAN.md 13.11, Odoo module
 * `incutec_catalog_api`).
 *
 * Replaces the former Resend-audience growth pipeline (`upsertContact`,
 * `contactExists`, `sendWelcome`, per-SKU `notify-<handle>` segments) with a
 * single server-to-server call. Single opt-in: Odoo records the consent
 * (timestamp, source, hashed IP, brand), puts the address on that brand's
 * newsletter list in the same request, and sends one welcome mail. Every
 * mail carries a one-click unsubscribe that needs no login, so nothing in
 * this repository signs or verifies an unsubscribe token.
 *
 * Odoo picks the brand from the request host, so a second brand's front end
 * needs no change here.
 *
 *   POST {NEWSLETTER_ODOO_URL}/incutec/newsletter/subscribe
 *     {email, product?, ip?} -> {ok: true} | {ok: false, error}
 *
 * Authenticated with X-Newsletter-Dispatch-Secret, which must match the
 * system parameter incutec_catalog_api.newsletter_dispatch_secret (set from
 * env $NEWSLETTER_DISPATCH_SECRET by erp/config/configure.py --section
 * catalog_api). The response never reveals whether the address was already
 * subscribed — Odoo always answers {ok: true} for a well-formed request,
 * whether the address was new or already on the list.
 *
 * Best-effort in shape only, not in effect: unlike the old growth pipeline
 * (fire-and-forget via `waitUntil`, always reporting success to the
 * visitor), this call IS the product feature, so the caller awaits it and
 * shows a real failure message when Odoo is unreachable or misconfigured —
 * matching app/lib/support/odoo.ts's one-retry policy but without the
 * "never block the visitor" guarantee that only applies to a side channel.
 */

const DEFAULT_ODOO_URL = 'https://erp.incutec.eu';
const ODOO_TIMEOUT_MS = 5000;

type NewsletterEnv = {
  NEWSLETTER_ODOO_URL?: string;
  NEWSLETTER_DISPATCH_SECRET?: string;
};

function baseUrl(env: NewsletterEnv): string {
  return (env.NEWSLETTER_ODOO_URL || DEFAULT_ODOO_URL).replace(/\/+$/, '');
}

export function hasNewsletterBridge(env: NewsletterEnv): boolean {
  return Boolean(env.NEWSLETTER_DISPATCH_SECRET);
}

/**
 * Subscribe an address to the calling brand's newsletter.
 * `product` is the optional coming-soon "notify me at launch" handle
 * (NewsletterSignup.tsx's `notify` prop) — Odoo records it on the consent
 * row but does not (yet) segment mailings by it; see the module's own
 * README for what changed from the old per-SKU Resend segments.
 * `ip` is the visitor's address, which only this Worker sees: Odoo stores a
 * hash of it as consent evidence and never the address.
 *
 * Returns true only when Odoo accepted the request (200 {ok: true});
 * false on any failure, including NEWSLETTER_DISPATCH_SECRET being unset.
 * At most one retry on a network error or a 5xx; a 4xx is not retried.
 * Never throws.
 */
export async function subscribeToNewsletter(
  env: NewsletterEnv,
  opts: {email: string; product?: string; ip?: string},
): Promise<boolean> {
  if (!env.NEWSLETTER_DISPATCH_SECRET) {
    console.warn(
      '[growth/odoo-newsletter] NEWSLETTER_DISPATCH_SECRET not set — subscribe skipped',
    );
    return false;
  }
  const body = JSON.stringify({
    email: opts.email,
    ...(opts.product ? {product: opts.product} : {}),
    ...(opts.ip ? {ip: opts.ip} : {}),
  });
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${baseUrl(env)}/incutec/newsletter/subscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Newsletter-Dispatch-Secret': env.NEWSLETTER_DISPATCH_SECRET,
        },
        body,
        signal: AbortSignal.timeout(ODOO_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as {ok?: boolean} | null;
        return data?.ok === true;
      }
      if (res.status < 500) {
        console.warn('[growth/odoo-newsletter] subscribe rejected', res.status);
        return false;
      }
      lastErr = new Error(`odoo newsletter subscribe ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt === 1) {
      console.warn('[growth/odoo-newsletter] subscribe failed, retrying once', lastErr);
    }
  }
  console.warn('[growth/odoo-newsletter] subscribe failed after retry', lastErr);
  return false;
}
