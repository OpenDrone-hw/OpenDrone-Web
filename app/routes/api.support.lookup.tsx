import {data} from 'react-router';
import type {Route} from './+types/api.support.lookup';
import {sendTicketIndex} from '~/lib/support/email';
import {buildResumeUrl, signResumeToken} from '~/lib/support/resume-token';
import {randomId} from '~/lib/support/session';
import {searchOdooTickets} from '~/lib/support/odoo';
import {bindingRateLimit, checkRateLimit, clientIp} from '~/lib/rate-limit';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type LookupResult = {ok: true} | {ok: false; message: string};

/**
 * "Resume by email" — the customer enters the email they used when they
 * opened a ticket. We look up the tickets on file for that email (Odoo,
 * erp/addons/incutec_support) and send a resume link per match in one
 * consolidated email.
 *
 * Privacy: the response is *always* a generic success message regardless
 * of whether matches were found. We never confirm or deny that a given
 * email has tickets — that would let an attacker fingerprint customers.
 * The only signal is the inbox: tickets exist iff an email arrives.
 *
 * Abuse / amplification: the Odoo search is one indexed query, no fan-out.
 * Rate limits use the Workers Rate Limiting binding (wrangler.toml) so
 * they hold *across* Worker isolates instead of per-isolate — the
 * per-email cap is what stops this being used to spam a victim's inbox
 * with resume mails. The binding's platform ceiling is a 60s window
 * (Cloudflare only supports 10s/60s), so the former 10-minute IP cap and
 * 24-hour email cap are approximated as 60s windows at the same counts;
 * falls back to the in-memory limiter (per-isolate, original windows)
 * when the binding isn't configured (e.g. local dev). Honeypot too.
 * (Turnstile isn't used here because the resume form shares the widget
 * with the ticket-intake form which already carries a Turnstile widget —
 * double-rendering the challenge would reset the first on interaction.)
 */
export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<LookupResult>(
      {ok: false, message: 'Method not allowed.'},
      {status: 405},
    );
  }
  const env = context.env;
  const ip = clientIp(request);

  const ipLimit = await rateLimit(
    env.SUPPORT_LOOKUP_IP_LIMITER,
    `support-lookup:ip:${ip}`,
    3,
    10 * 60 * 1000,
  );
  if (!ipLimit.allowed) {
    return data<LookupResult>(
      {ok: false, message: 'Too many requests. Try again later.'},
      {
        status: 429,
        headers: {'Retry-After': String(ipLimit.resetInSeconds)},
      },
    );
  }

  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const honeypot = String(form.get('website') ?? '');

  if (honeypot) return data<LookupResult>({ok: true});
  if (!email || !EMAIL_REGEX.test(email) || email.length > 254) {
    return data<LookupResult>(
      {ok: false, message: 'Enter a valid email address.'},
      {status: 400},
    );
  }

  const emailLimit = await rateLimit(
    env.SUPPORT_LOOKUP_EMAIL_LIMITER,
    `support-lookup:email:${email}`,
    2,
    24 * 60 * 60 * 1000,
  );
  // When the email-level limit kicks in we still answer with the same
  // privacy-preserving generic success — never confirm or deny tickets.
  if (!emailLimit.allowed) return data<LookupResult>({ok: true});

  // Resolve + email asynchronously — we always tell the user "check your
  // inbox" within ~50ms regardless of how long the Odoo lookup + Resend
  // round-trip takes.
  const job = (async () => {
    try {
      const matches = await searchOdooTickets(env, {email});
      if (!matches.length) return;

      const baseUrl = new URL(request.url).origin;
      const tickets = await Promise.all(
        matches.map(async (t) => {
          const token = await signResumeToken(env, {
            tid: t.tid,
            uid: randomId(),
            email,
            // We don't carry the original name in this flow — the resume
            // route uses what's in the token, so a placeholder is fine.
            // Staff already see the original name in the Discord post.
            name: 'You',
            pid: t.pid,
          });
          return {
            subject: t.subject,
            openedAt: t.openedAt
              ? new Date(t.openedAt * 1000).toLocaleDateString('en-GB')
              : 'recently',
            resumeUrl: buildResumeUrl(baseUrl, token),
          };
        }),
      );

      await sendTicketIndex(env, {to: email, tickets});
    } catch (err) {
      console.warn('[support/lookup] failed', err);
    }
  })();
  if (context.waitUntil) context.waitUntil(job);
  else void job;

  return data<LookupResult>({ok: true});
}

// Prefer the Workers Rate Limiting binding (shared across isolates); fall
// back to the per-isolate in-memory limiter, at the original limit/window,
// when the binding is missing.
async function rateLimit(
  binding: Parameters<typeof bindingRateLimit>[0],
  key: string,
  limit: number,
  windowMs: number,
): Promise<{allowed: boolean; resetInSeconds: number}> {
  const bound = await bindingRateLimit(binding, key);
  if (bound) return {allowed: bound.allowed, resetInSeconds: 60};
  const local = checkRateLimit(key, limit, windowMs);
  return {allowed: local.allowed, resetInSeconds: local.resetInSeconds};
}

export function loader() {
  return new Response(null, {status: 404});
}
