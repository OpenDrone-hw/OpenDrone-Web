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
 * The markup mirrors scripts/shopify-templates/_base.html so a welcome mail
 * and a Shopify order mail look like the same company. Edit both together.
 */

// Relative import with the extension, like app/lib/preorder.ts: this module
// is loaded by the node:test suite without Vite, so the `~` alias and
// extensionless resolution are not available.
import {signUnsubscribeToken} from './unsubscribe-token.ts';

const RESEND_API = 'https://api.resend.com/emails';

type WelcomeEnv = {
  RESEND_API_KEY?: string;
  NEWSLETTER_FROM_EMAIL?: string;
  SUPPORT_FROM_EMAIL?: string;
  PUBLIC_COMPANY_NAME?: string;
  SESSION_SECRET?: string;
};

const SITE = 'https://opendrone.be';
const WORDMARK =
  'https://cdn.shopify.com/s/files/1/1032/6641/9033/files/opendrone-wordmark-email-blackgold_39eb37d0-777f-4a31-b2f3-eb25965c97d7.png?v=1786703416';

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    'Incutec BV, Stapelhuisstraat 15, 3000 Leuven, Belgium. VAT BE1038934039',
  ].join('\n');

  const row = (label: string, value: string) => `
              <tr>
                <td style="padding:0 0 8px 0;font-family:'JetBrains Mono','Courier New',monospace;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#a0a0a0;width:130px;vertical-align:top;">${label}</td>
                <td style="padding:0 0 8px 0;font-family:'JetBrains Mono','Courier New',monospace;font-size:12px;color:#e5e5e5;">${value}</td>
              </tr>`;

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#0a0a0a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">You're subscribed to Engineering Essentials.</div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#0a0a0a;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background-color:#101210;">
        <tr>
          <td style="background-color:#ffffff;padding:20px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td align="left"><img src="${WORDMARK}" alt="OpenDrone" width="160" height="39" style="display:block;border:0;width:160px;height:39px;" /></td>
                <td align="right" style="font-family:'JetBrains Mono','Courier New',monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#4a4a4a;">Subscription confirmed</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:40px 32px 0 32px;">
            <p style="margin:0 0 14px 0;font-family:'JetBrains Mono','Courier New',monospace;font-size:13px;letter-spacing:0.2em;text-transform:uppercase;color:#ffb700;">Engineering Essentials</p>
            <h1 style="margin:0 0 20px 0;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:32px;line-height:1.15;font-weight:700;letter-spacing:-0.01em;color:#e5e5e5;">You&rsquo;re in.</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 28px 32px;">
            <p style="margin:0 0 16px 0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#c5c5c5;">Thanks for subscribing. You&rsquo;ll get an email from us when there&rsquo;s actually something to ship: new hardware, firmware releases, field notes from the bench.</p>
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#c5c5c5;">Expect roughly one email a month. No marketing fluff, no sponsored junk. Unsubscribe any time: the link is at the bottom of every email, this one included.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 28px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #1f231f;">
              <tr><td style="padding:20px 24px 12px 24px;">
                <p style="margin:0 0 14px 0;font-family:'JetBrains Mono','Courier New',monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a0a0a0;">What to expect</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${row('Cadence', 'Monthly, give or take')}
${row('Content', 'Product releases, build notes, bench updates')}
${row('Unsubscribe', 'Link at the bottom of every email')}
                </table>
              </td></tr>
            </table>
          </td>
        </tr>${
          product
            ? `
        <tr>
          <td style="padding:0 32px 28px 32px;">
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#c5c5c5;">You also asked for the launch email for <strong style="color:#e5e5e5;">${escapeHtml(product)}</strong>. You&rsquo;ll get that one first.</p>
          </td>
        </tr>`
            : ''
        }
        <tr>
          <td style="padding:0 32px 40px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="background-color:#ffb700;">
                <a href="${SITE}/products" style="display:inline-block;padding:14px 28px;font-family:'JetBrains Mono','Courier New',monospace;font-size:13px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#0a0a0a;text-decoration:none;">Browse the hardware &rarr;</a>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 32px 32px;border-top:1px solid #1f231f;">
            <p style="margin:0 0 10px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#a0a0a0;">Not you, or not interested? <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#ffb700;">Unsubscribe with one click</a>.</p>
            <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#4a4a4a;">Incutec BV, Stapelhuisstraat 15, 3000 Leuven, Belgium. VAT BE1038934039 &middot; <a href="${SITE}" style="color:#4a4a4a;">opendrone.be</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

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
