/**
 * Transactional email for the support bridge - sent via Resend.
 *
 * Two senders:
 *  - sendResumeLink:    one ticket → one resume URL. Fired on ticket creation.
 *  - sendTicketIndex:   list of resume URLs for a given email. Fired by the
 *                       lookup endpoint when a returning user wants every
 *                       ticket they've ever opened from this address.
 *
 * If RESEND_API_KEY is unset (local dev or staging without the secret) the
 * functions log and no-op so the rest of the system still works end-to-end
 * with the cookie path. The bridge is designed to degrade gracefully.
 */

const RESEND_API = 'https://api.resend.com/emails';

type Env = {
  RESEND_API_KEY?: string;
  SUPPORT_FROM_EMAIL?: string;
  PUBLIC_COMPANY_NAME?: string;
};

type SendOpts = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
};

async function send(env: Env, opts: SendOpts): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('[support/email] RESEND_API_KEY not set - would have sent', {
      to: redactEmail(opts.to),
      subject: opts.subject,
    });
    return false;
  }
  const from = env.SUPPORT_FROM_EMAIL || 'support@opendrone.be';
  const fromDisplay = env.PUBLIC_COMPANY_NAME
    ? `${env.PUBLIC_COMPANY_NAME} Support <${from}>`
    : `OpenDrone Support <${from}>`;

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
        to: [opts.to],
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        reply_to: opts.replyTo,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[support/email] resend', res.status, body.slice(0, 240));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[support/email] send failed', err);
    return false;
  }
}

export async function sendResumeLink(
  env: Env,
  opts: {
    to: string;
    name: string;
    subject: string;
    resumeUrl: string;
    // Odoo `ticket_ref` (e.g. "SUP-00001"), when the erp/addons/incutec_support
    // bridge call succeeded (PLAN.md 12.2, D13: appended only, nothing else
    // about this email changes). Absent when Odoo was unreachable.
    odooRef?: string;
  },
): Promise<boolean> {
  const subjectLine = opts.odooRef
    ? `${opts.subject} (ref ${opts.odooRef})`
    : opts.subject;
  const text = [
    `Hi ${opts.name || 'there'},`,
    '',
    `Thanks for opening a support ticket with us. Save this email: the link below restores your chat from any device, even if you clear cookies or switch browsers.`,
    '',
    `Your ticket: ${subjectLine}`,
    `Resume: ${opts.resumeUrl}`,
    '',
    `If you didn't open this ticket, just ignore this message. The link only works if you actually started the chat.`,
    '',
    `OpenDrone`,
  ].join('\n');

  const html = renderEmail({
    heading: 'Your support ticket',
    body: `
      <p>Hi ${escapeHtml(opts.name || 'there')},</p>
      <p>Thanks for opening a support ticket with us. Save this email: the link below restores your chat from any device, even if you clear cookies or switch browsers.</p>
      <p style="margin-top:24px">
        <strong>${escapeHtml(subjectLine)}</strong>
      </p>
      <p style="margin:16px 0 32px">
        <a href="${escapeAttr(opts.resumeUrl)}" style="display:inline-block;background:#ffb700;color:#0a0a0a;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;padding:12px 18px;border-radius:2px">Resume chat →</a>
      </p>
      <p style="color:#737373;font-size:13px;line-height:1.6">If you didn't open this ticket, just ignore this message. The link only works if you actually started the chat.</p>
    `,
  });

  return send(env, {
    to: opts.to,
    subject: `Your support ticket: ${opts.subject}`,
    text,
    html,
  });
}

export async function sendReplyNotification(
  env: Env,
  opts: {
    to: string;
    name: string;
    subject: string;
    resumeUrl: string;
    // One entry per staff reply, oldest first. The sweep batches every
    // unseen reply into a single email; previews are capped below.
    replies: Array<{staffFirstName: string; preview: string}>;
  },
): Promise<boolean> {
  if (!opts.replies.length) return false;
  const shown = opts.replies.slice(0, 5);
  const extra = opts.replies.length - shown.length;
  const single = opts.replies.length === 1;
  const intro = single
    ? `${shown[0].staffFirstName} replied to your OpenDrone support ticket.`
    : `You have ${opts.replies.length} new replies on your OpenDrone support ticket.`;

  const text = [
    `Hi ${opts.name || 'there'},`,
    '',
    intro,
    '',
    `Ticket: ${opts.subject}`,
    ...shown.map((r) => {
      const preview = r.preview.slice(0, 240);
      return single ? `> ${preview}` : `> ${r.staffFirstName}: ${preview}`;
    }),
    extra > 0 ? `(+${extra} more in the chat)` : null,
    '',
    `Continue here: ${opts.resumeUrl}`,
    '',
    `OpenDrone support`,
  ]
    .filter((line) => line !== null)
    .join('\n');

  const blockquotes = shown
    .map((r) => {
      const preview = escapeHtml(r.preview.slice(0, 240));
      const label = single
        ? ''
        : `<strong style="color:#e5e5e5">${escapeHtml(r.staffFirstName)}</strong><br>`;
      return `<blockquote style="margin:12px 0 0;padding:10px 14px;border-left:2px solid #ffb700;background:#141417;color:#cfcfcf;font-size:13px;line-height:1.6">${label}${preview}</blockquote>`;
    })
    .join('');

  const html = renderEmail({
    heading: single
      ? `${escapeHtml(shown[0].staffFirstName)} replied to your ticket`
      : 'New replies on your ticket',
    body: `
      <p>Hi ${escapeHtml(opts.name || 'there')},</p>
      <p>${escapeHtml(intro)}</p>
      <p style="margin-top:18px"><strong>${escapeHtml(opts.subject)}</strong></p>
      ${blockquotes}
      ${
        extra > 0
          ? `<p style="color:#737373;font-size:13px">+${extra} more in the chat.</p>`
          : ''
      }
      <p style="margin:24px 0 32px">
        <a href="${escapeAttr(opts.resumeUrl)}" style="display:inline-block;background:#ffb700;color:#0a0a0a;text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;padding:12px 18px;border-radius:2px">Continue chat →</a>
      </p>
      <p style="color:#737373;font-size:13px;line-height:1.6">You're receiving this because you opened a support ticket with us. The link above restores your conversation from any device.</p>
    `,
  });

  return send(env, {
    to: opts.to,
    subject: `Re: ${opts.subject}`,
    text,
    html,
  });
}

export async function sendTicketIndex(
  env: Env,
  opts: {
    to: string;
    tickets: Array<{subject: string; openedAt: string; resumeUrl: string}>;
  },
): Promise<boolean> {
  if (!opts.tickets.length) return false;
  const lines = opts.tickets.map(
    (t) => `• ${t.subject} (opened ${t.openedAt})\n  ${t.resumeUrl}`,
  );
  const text = [
    `Hi,`,
    '',
    `Here are the support tickets you've opened with us. Click any link to resume the chat from this device.`,
    '',
    ...lines,
    '',
    `Each link is one-way: only the chat it points to gets restored.`,
    '',
    `OpenDrone`,
  ].join('\n');

  const htmlList = opts.tickets
    .map(
      (t) =>
        `<li style="margin:12px 0">
          <div style="font-weight:600">${escapeHtml(t.subject)}</div>
          <div style="color:#737373;font-size:13px;margin:2px 0 6px">opened ${escapeHtml(t.openedAt)}</div>
          <a href="${escapeAttr(t.resumeUrl)}" style="color:#ffb700;text-decoration:underline;font-family:'JetBrains Mono',monospace;font-size:12px">Resume chat →</a>
        </li>`,
    )
    .join('');
  const html = renderEmail({
    heading: 'Your OpenDrone support tickets',
    body: `
      <p>Here are the support tickets you've opened with us. Click any link to resume the chat from this device.</p>
      <ul style="list-style:none;padding:0;margin:24px 0">${htmlList}</ul>
      <p style="color:#737373;font-size:13px;line-height:1.6">Each link is one-way: only the chat it points to gets restored.</p>
    `,
  });
  return send(env, {
    to: opts.to,
    subject: `Your OpenDrone support tickets`,
    text,
    html,
  });
}

function renderEmail({heading, body}: {heading: string; body: string}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;font-family:Helvetica,Arial,sans-serif;line-height:1.55">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a">
    <tr><td align="center" style="padding:32px 16px">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#141417;border:1px solid #1a241a;border-radius:3px">
        <tr><td bgcolor="#ffffff" style="padding:16px 28px;background:#ffffff">
          <img src="https://cdn.shopify.com/s/files/1/1032/6641/9033/files/opendrone-wordmark-email-blackgold_39eb37d0-777f-4a31-b2f3-eb25965c97d7.png?v=1786703416" alt="OpenDrone" width="160" height="39" style="display:block;border:0;height:39px;width:160px" />
        </td></tr>
        <tr><td style="padding:24px 28px 0">
          <h1 style="font-family:Helvetica,Arial,sans-serif;font-size:22px;letter-spacing:-0.01em;margin:0;color:#e5e5e5">${escapeHtml(heading)}</h1>
        </td></tr>
        <tr><td style="padding:18px 28px 28px;color:#e5e5e5;font-size:15px">${body}</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function redactEmail(s: string): string {
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return `${s[0]}***@${s.slice(at + 1)}`;
}
