import {data, useLoaderData} from 'react-router';
import type {Route} from './+types/newsletter._index';
import {buildSeoMeta} from '~/lib/seo';
import {checkRateLimit, clientIp} from '~/lib/rate-limit';
import {verifyTurnstile} from '~/lib/turnstile';
import {subscribeWithShopify} from '~/lib/growth/shopify-newsletter';
import {sendWelcomeEmail} from '~/lib/growth/welcome-email';
import {archivePosts, shopIsOpen} from '~/lib/posts';
import {
  ReleaseRow,
  type ReleaseRowArticle,
} from '~/components/release-notes/ReleaseRow';
import {Txt} from '~/components/Txt';
import {copyText} from '~/lib/copy';

// Newsletter - the single hub. It's all newsletter: posts authored as
// Markdown in content/posts/ show up here as the archive, at /newsletter
// (posts at /newsletter/<handle>). Old /blog, /releases, and /blogs URLs
// redirect in.
//
// GET  → renders the post archive (this is the newsletter).
// POST → records single-opt-in consent in Shopify. Product launch signups also
// carry a `notify-<handle>` customer tag; plain signups carry `newsletter`.
//
// The signup FORM lives in the site footer (present on every page), so this
// page intentionally has no in-body form - it would just duplicate the footer.
//
// Abuse controls on the action: honeypot + Cloudflare Turnstile + per-IP and
// per-email rate limits. Turnstile is soft - if TURNSTILE_SITE_KEY is unset
// (dev) the verifier no-ops; in production it fails closed.

export const meta: Route.MetaFunction = () => {
  const base = buildSeoMeta({
    title: copyText('newsletter.meta_title') ?? 'Newsletter',
    description:
      copyText('newsletter.meta_description') ??
      'Engineering Essentials: engineering notes, hardware releases, and write-ups from OpenDrone. Subscribe to get each post by email.',
  });
  return [
    ...base,
    {
      tagName: 'link',
      rel: 'alternate',
      type: 'application/rss+xml',
      title: copyText('newsletter.rss_link_title') ?? 'OpenDrone · Newsletter',
      href: '/newsletter.rss',
    },
  ];
};

export function loader({context}: Route.LoaderArgs) {
  const visible: ReleaseRowArticle[] = archivePosts(shopIsOpen(context.env)).map((p) => ({
    id: p.handle,
    handle: p.handle,
    title: p.title,
    publishedAt: p.publishedAt,
    excerpt: p.excerpt,
    tags: p.tags,
    image: p.image,
  }));

  // Group by year, descending - posts already reverse-chronological.
  const grouped = new Map<string, ReleaseRowArticle[]>();
  for (const a of visible) {
    const year = a.publishedAt.slice(0, 4);
    if (!grouped.has(year)) grouped.set(year, []);
    grouped.get(year)!.push(a);
  }

  return {groups: Array.from(grouped.entries())};
}

export default function NewsletterPage() {
  const {groups} = useLoaderData<typeof loader>();

  return (
    <div className="page-shell">
      <header className="rn-archive-head">
        <div>
          <p className="rn-eyebrow">
            <Txt id="newsletter.eyebrow" />
            <a href="/newsletter.rss" className="rn-rss" rel="alternate">
              <Txt id="newsletter.rss_label" />
            </a>
          </p>
          <Txt id="newsletter.title" as="h1" />
        </div>
      </header>

      {groups.length > 0 ? (
        <div>
          {groups.map(([year, articles]) => (
            <section key={year}>
              <div className="rn-year">
                <span className="rn-year-n">{year}</span>
                <span className="rn-year-rule" aria-hidden />
                <span className="rn-year-count">
                  {articles.length}{' '}
                  <Txt
                    id={
                      articles.length === 1
                        ? 'newsletter.count_one'
                        : 'newsletter.count_other'
                    }
                  />
                </span>
              </div>
              <ol className="rn-list">
                {articles.map((a) => (
                  <ReleaseRow key={a.id} article={a} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <div className="rn-empty">
          <div className="rn-empty-icon" aria-hidden>
            ·
          </div>
          <Txt id="newsletter.empty_title" as="h3" />
          <Txt id="newsletter.empty_body" as="p" />
        </div>
      )}
    </div>
  );
}

// --- Signup action ---------------------------------------------------------

type NewsletterResult = {
  ok: boolean;
  message: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Optional `product` form field: a catalog handle from the coming-soon
// "Notify me at launch" signup. Strict slug shape: it becomes a Shopify
// customer tag, so nothing free-form gets through.
const PRODUCT_HANDLE_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<NewsletterResult>(
      {ok: false, message: (copyText('newsletter.action_method_not_allowed') ?? 'Method not allowed.')},
      {status: 405},
    );
  }

  const ip = clientIp(request);
  const ipLimit = checkRateLimit(`newsletter:ip:${ip}`, 5, 10 * 60 * 1000);
  if (!ipLimit.allowed) {
    return data<NewsletterResult>(
      {ok: false, message: (copyText('newsletter.action_rate_limited') ?? 'Too many requests. Try again in a few minutes.')},
      {
        status: 429,
        headers: {'Retry-After': String(ipLimit.resetInSeconds)},
      },
    );
  }

  const formData = await request.formData();
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const consent = formData.get('consent') === 'on';
  const honeypot = String(formData.get('website') ?? '');
  const turnstileToken = String(formData.get('cf-turnstile-response') ?? '');
  const productRaw = String(formData.get('product') ?? '')
    .trim()
    .toLowerCase();
  const notifyProduct = PRODUCT_HANDLE_REGEX.test(productRaw)
    ? productRaw
    : null;

  if (honeypot) {
    return data<NewsletterResult>({ok: true, message: (copyText('newsletter.action_honeypot') ?? 'Thanks.')});
  }

  if (!email || !EMAIL_REGEX.test(email) || email.length > 254) {
    return data<NewsletterResult>(
      {ok: false, message: (copyText('newsletter.action_invalid_email') ?? 'Enter a valid email address.')},
      {status: 400},
    );
  }

  if (!consent) {
    return data<NewsletterResult>(
      {ok: false, message: (copyText('newsletter.action_no_consent') ?? 'Please confirm you want to receive updates.')},
      {status: 400},
    );
  }

  // Verify Turnstile before any consent write.
  const turnstile = await verifyTurnstile(context.env, turnstileToken, ip);
  if (!turnstile.ok) {
    return data<NewsletterResult>(
      {ok: false, message: (copyText('newsletter.action_turnstile_failed') ?? 'Could not verify you are human. Refresh and try again.')},
      {status: 400},
    );
  }

  const emailLimit = checkRateLimit(
    `newsletter:email:${email}`,
    3,
    24 * 60 * 60 * 1000,
  );
  if (!emailLimit.allowed) {
    // The earlier successful request already recorded consent and tags.
    return data<NewsletterResult>({
      ok: true,
      message:
        copyText('newsletter.action_already_listed') ??
        'You are already on the list. Nothing more to do.',
    });
  }

  const shopifyResult = await subscribeWithShopify(
    context.env,
    email,
    notifyProduct ?? undefined,
  );
  const subscribed =
    shopifyResult === 'subscribed' ||
    shopifyResult === 'already-subscribed' ||
    shopifyResult === 'suppressed';
  if (!subscribed) {
    return data<NewsletterResult>(
      {
        ok: false,
        message:
          copyText('newsletter.action_generic_failure') ??
          "Couldn't subscribe right now. Try again in a moment.",
      },
      {status: 502},
    );
  }

  // Welcome mail, only for an address that actually joined on this call.
  // Shopify owns the consent but sends nothing for an Admin API write, so the
  // storefront sends it. Fire-and-forget: the consent is already recorded, and
  // a Resend hiccup must not turn a successful signup into an error. A repeat
  // submit returns `already-subscribed` and is not welcomed twice.
  if (shopifyResult === 'subscribed') {
    const welcome = sendWelcomeEmail(context.env, {
      email,
      product: notifyProduct ?? undefined,
    });
    if (context.waitUntil) context.waitUntil(welcome);
    else await welcome;
  }

  // The response never reveals whether the address already existed.
  if (notifyProduct) {
    return data<NewsletterResult>({
      ok: true,
      message:
        copyText('newsletter.action_notify_listed') ??
        "You're on the list. We'll email you when this product launches.",
    });
  }

  return data<NewsletterResult>({
    ok: true,
    message:
      copyText('newsletter.action_subscribed') ??
      'Subscribed. You will receive updates when they are published.',
  });
}
