import {data, useFetcher, useLoaderData} from 'react-router';
import type {Route} from './+types/newsletter.unsubscribe';
import {buildSeoMeta, SITE_ORIGIN} from '~/lib/seo';
import {checkRateLimit, clientIp} from '~/lib/rate-limit';
import {verifyUnsubscribeToken} from '~/lib/growth/unsubscribe-token';
import {unsubscribeWithShopify} from '~/lib/growth/shopify-newsletter';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

// Newsletter opt-out — the URL every OpenDrone email footer points at.
//
// GET  → with a valid `t` token (minted at welcome-email time): a one-click
//        confirm button bound to that email. Without/with an invalid token:
//        a plain email form. GET never unsubscribes anything — inbox link
//        scanners prefetch GETs.
// POST → does the opt-out in Shopify (the consent owner) and Resend (the
//        delivery suppression). Both writes are gated and must succeed before
//        confirmation. Token-authenticated POSTs skip the rate limit;
//        form POSTs get honeypot + per-IP limit. The response is the same
//        generic confirmation either way, so the endpoint never confirms
//        whether an address was subscribed.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const meta: Route.MetaFunction = ({location}) =>
  buildSeoMeta({
    title: copyText('newsletter.unsub_meta_title') ?? 'Unsubscribe',
    description:
      copyText('newsletter.unsub_meta_description') ??
      'Unsubscribe from OpenDrone emails.',
    robots: 'noindex',
    url: `${SITE_ORIGIN}${location.pathname}`,
  });

export async function loader({request, context}: Route.LoaderArgs) {
  const url = new URL(request.url);
  const verified = await verifyUnsubscribeToken(
    context.env,
    url.searchParams.get('t'),
  );
  return {
    tokenEmail: verified?.email ?? null,
    token: verified ? url.searchParams.get('t') : null,
    prefill: url.searchParams.get('email') ?? '',
  };
}

type UnsubscribeResult = {ok: boolean; message: string};

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<UnsubscribeResult>(
      {
        ok: false,
        message:
          copyText('newsletter.unsub_method_not_allowed') ??
          'Method not allowed.',
      },
      {status: 405},
    );
  }
  const formData = await request.formData();
  const token = String(formData.get('t') ?? '');
  const verified = await verifyUnsubscribeToken(context.env, token);

  let email: string;
  if (verified) {
    // Token binds the address — no further checks needed.
    email = verified.email;
  } else {
    if (String(formData.get('website') ?? '')) {
      // Honeypot filled — pretend success.
      return data<UnsubscribeResult>({ok: true, message: doneMessage()});
    }
    const ip = clientIp(request);
    const limit = checkRateLimit(`unsubscribe:ip:${ip}`, 5, 10 * 60 * 1000);
    if (!limit.allowed) {
      return data<UnsubscribeResult>(
        {
          ok: false,
          message:
            copyText('newsletter.unsub_rate_limited') ??
            'Too many requests. Try again in a few minutes.',
        },
        {status: 429, headers: {'Retry-After': String(limit.resetInSeconds)}},
      );
    }
    email = String(formData.get('email') ?? '')
      .trim()
      .toLowerCase();
    if (!email || !EMAIL_REGEX.test(email) || email.length > 254) {
      return data<UnsubscribeResult>(
        {
          ok: false,
          message:
            copyText('newsletter.unsub_invalid_email') ??
            'Enter a valid email address.',
        },
        {status: 400},
      );
    }
  }

  const result = await unsubscribeWithShopify(context.env, email);
  if (result !== 'unsubscribed') {
    return data<UnsubscribeResult>(
      {
        ok: false,
        message:
          copyText('newsletter.action_generic_failure') ??
          "Couldn't unsubscribe right now. Try again in a moment.",
      },
      {status: result === 'disabled' ? 404 : 502},
    );
  }

  return data<UnsubscribeResult>({ok: true, message: doneMessage()});
}

// A function, not a module const: read at request time so a studio edit to
// the copy file takes effect without restarting the worker.
const doneMessage = () =>
  copyText('newsletter.unsub_done') ??
  "Done. If this address was on any OpenDrone list, it isn't anymore.";

export default function UnsubscribePage() {
  const {tokenEmail, token, prefill} = useLoaderData<typeof loader>();
  const fetcher = useFetcher<UnsubscribeResult>();
  const result = fetcher.data;
  const busy = fetcher.state !== 'idle';

  return (
    <div className="page-shell">
      <header className="rn-archive-head">
        <div>
          <p className="rn-eyebrow">
            <Txt id="newsletter.unsub_eyebrow" />
          </p>
          <Txt id="newsletter.unsub_title" as="h1" />
        </div>
      </header>

      <div className="max-w-xl">
        {result?.ok ? (
          <p className="text-[var(--color-text)]">{result.message}</p>
        ) : tokenEmail ? (
          <fetcher.Form method="post">
            <input type="hidden" name="t" value={token ?? ''} />
            <p className="mb-4 text-[var(--color-text-dim)]">
              <Txt id="newsletter.unsub_confirm_before" />{' '}
              <strong className="text-[var(--color-text)]">{tokenEmail}</strong>
              ?
            </p>
            <button
              type="submit"
              disabled={busy}
              className="border border-[var(--color-border)] bg-[var(--color-accent)] px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-[var(--color-on-accent)] disabled:opacity-60"
            >
              <Txt
                id={busy ? 'newsletter.unsub_busy' : 'newsletter.unsub_submit'}
              />
            </button>
          </fetcher.Form>
        ) : (
          <fetcher.Form method="post">
            <Txt
              id="newsletter.unsub_form_lede"
              as="p"
              className="mb-4 text-[var(--color-text-dim)]"
            />
            {/* Honeypot — same trick as the signup form. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="hidden"
            />
            <div className="flex flex-wrap gap-3">
              <input
                type="email"
                name="email"
                required
                defaultValue={prefill}
                placeholder={copyText('newsletter.unsub_email_placeholder')}
                className="min-w-64 flex-1 border border-[var(--color-border)] bg-transparent px-4 py-2.5 font-mono text-[13px] text-[var(--color-text)]"
              />
              <button
                type="submit"
                disabled={busy}
                className="border border-[var(--color-border)] bg-[var(--color-accent)] px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-[var(--color-on-accent)] disabled:opacity-60"
              >
                <Txt
                  id={busy ? 'newsletter.unsub_busy' : 'newsletter.unsub_submit'}
                />
              </button>
            </div>
          </fetcher.Form>
        )}
        {result && !result.ok ? (
          <p className="mt-3 text-[13px] text-[var(--color-text-dim)]">
            {result.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
