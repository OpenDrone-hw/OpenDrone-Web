/**
 * Newsletter welcome email, sent by the storefront through Resend.
 *
 * Shopify owns consent, but it will not send anything for it. Its "Customer
 * marketing confirmation" notification only fires from Shopify's own
 * subscription flows; writing `PENDING` / `CONFIRMED_OPT_IN` through the Admin
 * API, as this storefront does, produces no send and no timeline event
 * (verified against the live store). So the welcome mail has to come from
 * here.
 *
 * Same degrade-soft contract as app/lib/support/email.ts: without
 * RESEND_API_KEY the send is skipped with a warning and the caller still
 * reports a successful signup. A failed welcome never fails a subscription -
 * the consent is already recorded and is the thing that matters.
 *
 * The markup comes from app/lib/email-shell.ts, the same shell the Shopify
 * order mails use, so a welcome mail and an order mail look like one company.
 */

// Relative import with the extension, like app/lib/preorder.ts: this module
// is loaded by the node:test suite without Vite, so the `~` alias and
// extensionless resolution are not available.
import {signUnsubscribeToken} from './unsubscribe-token.ts';
import {SITE, button, card, escapeHtml, head, keyValues, label, para, shell} from '../email-shell.ts';

const RESEND_API = 'https://api.resend.com/emails';

type WelcomeEnv = {
  RESEND_API_KEY?: string;
  NEWSLETTER_FROM_EMAIL?: string;
  SUPPORT_FROM_EMAIL?: string;
  PUBLIC_COMPANY_NAME?: string;
  SESSION_SECRET?: string;
};


// Display titles for the launch-list line. The form posts a catalog handle;
// without this the mail reads "launch list: openfc-lite".
const PRODUCT_TITLES: Record<string, string> = {
  openrx: 'OpenRX',
  openesc: 'OpenESC',
  'openfc-lite': 'OpenFC Lite',
  openframe: 'OpenFrame',
  openmotor: 'OpenMotor',
};

function productTitle(handle: string): string {
  return (
    PRODUCT_TITLES[handle] ??
    handle
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ')
  );
}

function redactEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

export function renderWelcomeEmail(opts: {
  unsubscribeUrl: string;
  product?: string;
}): {subject: string; text: string; html: string} {
  const product = opts.product ? productTitle(opts.product) : undefined;
  const subject = 'Welcome to Engineering Essentials';

  const text = [
    "You're in.",
    '',
    "Thanks for subscribing. You'll get an email from us when there's actually",
    'something to ship: new hardware, firmware releases, field notes from the bench.',
    '',
    'Expect roughly one email a month. No marketing fluff, no sponsored junk.',
    'Unsubscribe any time: the link is at the bottom of every email, this one included.',
    '',
    'What to expect',
    '  Cadence      Monthly, give or take',
    '  Content      Product releases, build notes, bench updates',
    '  Unsubscribe  Link at the bottom of every email',
    ...(product
      ? ['', `You also asked for the launch email for ${product}. You'll get that one first.`]
      : []),
    '',
    `Browse the hardware: ${SITE}/products`,
    '',
    `Unsubscribe: ${opts.unsubscribeUrl}`,
    '',
    'Incutec BV, Stapelhuisstraat 15, 3000 Leuven, Belgium. KBO 1038.934.039. BTW BE 1038.934.039',
  ].join('\n');

  const body =
    head('Engineering Essentials', 'You&rsquo;re in.') +
    para(
      'Thanks for subscribing. You&rsquo;ll get an email from us when there&rsquo;s actually something to ship: new hardware, firmware releases, field notes from the bench.',
    ) +
    para(
      'Expect roughly one email a month. No marketing fluff, no sponsored junk. Unsubscribe any time: the link is at the bottom of every email, this one included.',
      {last: true},
    ) +
    card(
      label('What to expect') +
        keyValues([
          ['Cadence', 'Monthly, give or take'],
          ['Content', 'Product releases, build notes, bench updates'],
          ['Unsubscribe', 'Link at the bottom of every email'],
        ]),
    ) +
    (product
      ? para(
          `You also asked for the launch email for <strong style="color: #e5e5e5;">${escapeHtml(product)}</strong>. You&rsquo;ll get that one first.`,
          {last: true},
        )
      : '') +
    button(`${SITE}/products`, 'Browse the hardware &rarr;');

  const html = shell({
    title: escapeHtml(subject),
    badge: 'Subscribed',
    preheader: 'You&rsquo;re subscribed to Engineering Essentials.',
    body,
    footerNote: `Not you, or not interested? <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color: #ffb700;">Unsubscribe with one click</a>.`,
  });

  return {subject, text, html};
}

/**
 * Send the welcome mail. Returns false on any failure or when Resend is not
 * configured; the caller treats the signup as successful regardless.
 */
export async function sendWelcomeEmail(
  env: WelcomeEnv,
  opts: {email: string; product?: string},
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('[growth/welcome] RESEND_API_KEY not set - would have sent', {
      to: redactEmail(opts.email),
    });
    return false;
  }

  // One-click link when SESSION_SECRET is set, else the plain form.
  const token = await signUnsubscribeToken(env, opts.email);
  const unsubscribeUrl = token
    ? `${SITE}/newsletter/unsubscribe?t=${encodeURIComponent(token)}`
    : `${SITE}/newsletter/unsubscribe`;

  const {subject, text, html} = renderWelcomeEmail({
    unsubscribeUrl,
    product: opts.product,
  });

  const from = env.NEWSLETTER_FROM_EMAIL || 'sales@incutec.eu';
  const fromDisplay = `${env.PUBLIC_COMPANY_NAME || 'OpenDrone'} <${from}>`;

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        from: fromDisplay,
        to: [opts.email],
        subject,
        text,
        html,
        reply_to: env.SUPPORT_FROM_EMAIL || 'support@opendrone.be',
        // RFC 8058: keeps Gmail and Outlook showing a native unsubscribe
        // control, which is also what keeps this out of the spam folder.
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[growth/welcome] resend', res.status, body.slice(0, 240));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[growth/welcome] send failed', err);
    return false;
  }
}
