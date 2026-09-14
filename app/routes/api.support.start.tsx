import {data} from 'react-router';
import type {Route} from './+types/api.support.start';
import {
  createSupportThread,
  firstNameOnly,
  postStaffMetadata,
} from '~/lib/support/discord';
import {sendResumeLink} from '~/lib/support/email';
import {
  buildResumeUrl,
  signResumeToken,
} from '~/lib/support/resume-token';
import {
  buildSupportSetCookie,
  randomId,
  randomTicketId,
  signTicket,
  type SupportTicket,
} from '~/lib/support/session';
import {verifyTurnstile} from '~/lib/support/turnstile';
import {extractAttachments} from '~/lib/support/uploads';
import {checkRateLimit, clientIp} from '~/lib/rate-limit';
import {scrubForDiscord} from '~/lib/support/scrubber';
import {
  addTicket,
  queueOdooMessage,
  type TicketMeta,
} from '~/lib/support/ticket-index';
import {flushOdooMirror} from '~/lib/support/odoo';

type StartResult =
  | {ok: true; ticketId: string; pid?: string}
  | {
      ok: false;
      message: string;
      field?: 'message' | 'turnstile' | 'files';
      code?: 'signin-required';
    };

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<StartResult>({ok: false, message: 'Method not allowed.'}, {status: 405});
  }

  const ip = clientIp(request);
  // Generous IP cap — abuse defence only. Per-customer throttling and
  // the auth gate below are the real protections; signed-in users
  // testing the flow shouldn't trip this.
  const ipLimit = checkRateLimit(`support-start:ip:${ip}`, 12, 60 * 60 * 1000);
  if (!ipLimit.allowed) {
    return data<StartResult>(
      {
        ok: false,
        message:
          'Too many tickets from this network. Try again in a bit, or join us on Discord.',
      },
      {
        status: 429,
        headers: {'Retry-After': String(ipLimit.resetInSeconds)},
      },
    );
  }

  // Opening a ticket used to require a Shopify customer-account session,
  // which supplied the name and email. Odoo owns accounts now and they
  // live on another domain, so the intake form carries them again;
  // Turnstile, the honeypot and the IP/email rate limits are the gate.
  const env = context.env;

  const form = await request.formData();
  const name = String(form.get('name') ?? '')
    .trim()
    .slice(0, 80);
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 254);
  const message = String(form.get('message') ?? '').trim();
  const turnstileToken = String(form.get('cf-turnstile-response') ?? '');
  const subject = String(form.get('subject') ?? '').trim().slice(0, 256);
  const product = String(form.get('product') ?? '').trim().slice(0, 80);
  const firmware = String(form.get('firmware') ?? '').trim().slice(0, 80);
  const honeypot = String(form.get('website') ?? '');

  if (honeypot) {
    return data<StartResult>({ok: true, ticketId: 'drop'});
  }
  if (name.length < 2) {
    return data<StartResult>(
      {ok: false, message: 'Tell us your name so we know who we are helping.'},
      {status: 400},
    );
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return data<StartResult>(
      {ok: false, message: 'Enter a valid email address.'},
      {status: 400},
    );
  }
  if (!subject || subject.length < 4) {
    return data<StartResult>(
      {
        ok: false,
        message: 'Add a short subject so we can find your ticket later.',
        field: 'message',
      },
      {status: 400},
    );
  }
  if (!message || message.length < 5 || message.length > 4000) {
    return data<StartResult>(
      {
        ok: false,
        message: 'Tell us a bit more (5–4000 chars).',
        field: 'message',
      },
      {status: 400},
    );
  }

  // Inbound scrub: strip credentials / cards / bidi overrides from the
  // user's message BEFORE it ever hits Discord. Narrower than the
  // outbound scrubber — users legitimately share their own email,
  // phone, order number, etc. when asking for help, so those pass
  // through. Only secrets / cards / control chars get replaced.
  const cleanMessage = scrubForDiscord(message);
  if (cleanMessage.blocked) {
    console.warn(
      '[support] inbound scrub blocked start message',
      cleanMessage.reasons.join(','),
    );
    return data<StartResult>(
      {
        ok: false,
        message:
          'Your message was rejected by our safety filter. Try rephrasing without any credentials, tokens, or card numbers.',
        field: 'message',
      },
      {status: 400},
    );
  }
  const cleanSubject = scrubForDiscord(subject).content;
  const cleanProduct = scrubForDiscord(product).content;
  const cleanFirmware = scrubForDiscord(firmware).content;
  // Prepend a metadata line into the customer's first message body so
  // staff see Product / Firmware up front in the Discord thread without
  // adding new fields to the cookie or wire schema.
  const metaLine = [
    cleanProduct ? `Product: ${cleanProduct}` : null,
    cleanFirmware ? `Firmware: ${cleanFirmware}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const messageWithMeta = metaLine
    ? `${metaLine}\n\n${cleanMessage.content}`
    : cleanMessage.content;

  const ua = request.headers.get('User-Agent') ?? undefined;

  const turnstile = await verifyTurnstile(env, turnstileToken, ip);
  if (!turnstile.ok) {
    return data<StartResult>(
      {
        ok: false,
        message: 'Could not verify you are human. Refresh and try again.',
        field: 'turnstile',
      },
      {status: 400},
    );
  }

  const attachments = await extractAttachments(form);
  if (!attachments.ok) {
    return data<StartResult>(
      {ok: false, message: attachments.message, field: 'files'},
      {status: 400},
    );
  }

  try {
    // When a private staff-metadata channel is configured, the public
    // forum thread (which any helper can read) gets a first-name-only
    // title and a redacted body. Email / Shopify GID / UA / IP go to
    // the staff channel below. Same toggle on both sides so they stay
    // consistent. The `redact` flag mirrors what createSupportThread
    // looks at internally — keeps the title and body in sync.
    const redact = !!env.DISCORD_STAFF_METADATA_CHANNEL_ID;
    const titleName = redact ? firstNameOnly(name) : name;
    // Public 10-digit reference. Goes into the thread title, the staff
    // metadata post, the cookie, and the widget header so customer +
    // staff can reference the ticket without mentioning the Discord
    // thread id.
    const pid = randomTicketId();
    const subjectFragment = cleanSubject
      ? cleanSubject
      : `${cleanMessage.content.slice(0, 50)}${
          cleanMessage.content.length > 50 ? '…' : ''
        }`;
    const thread = await createSupportThread(env, {
      title: `#${pid} [${titleName}] ${subjectFragment}`,
      userName: name,
      userEmail: email,
      firstMessage: messageWithMeta,
      userAgent: ua,
      ipHint: ip && ip !== 'unknown' ? anonymizeIp(ip) : undefined,
      files: attachments.files,
      pid,
    });

    // Staff metadata: full PII + jump-URL go to the role-restricted
    // channel only. No-op when DISCORD_STAFF_METADATA_CHANNEL_ID is
    // unset (legacy mode keeps the metadata in the public thread).
    // Fire-and-forget so a Discord hiccup here doesn't block the
    // ticket creation API response.
    if (redact) {
      const metaJob = (async () => {
        try {
          await postStaffMetadata(env, thread.id, thread.name, {
            userName: name,
            userEmail: email,
            userAgent: ua,
            ipHint: ip && ip !== 'unknown' ? anonymizeIp(ip) : undefined,
            pid,
          });
        } catch (err) {
          console.warn('[support/start] staff-metadata post failed', err);
        }
      })();
      if (context.waitUntil) context.waitUntil(metaJob);
      else void metaJob;
    }

    const ticket: SupportTicket = {
      v: 1,
      tid: thread.id,
      uid: randomId(),
      pid,
      name: name.slice(0, 80),
      email,
      createdAt: Math.floor(Date.now() / 1000),
    };
    const cookie = await signTicket(env, ticket);

    // Write ticket meta + the email index, mirror the ticket into Odoo
    // (erp/addons/incutec_support, PLAN.md 12.2), and send the resume-link
    // email — all fire-and-forget so a slow store write, an Odoo outage, or
    // Resend latency never tails the API response. The opening message is
    // written to the durable ticket outbox before Odoo is called; the notify
    // sweep retries it if this first attempt fails.
    const ticketIndexSubject = cleanSubject || cleanMessage.content.slice(0, 80);
    const ticketSubject = cleanSubject || cleanMessage.content.slice(0, 60);
    const backgroundJob = (async () => {
      const meta: TicketMeta = {
        tid: thread.id,
        pid,
        subject: ticketIndexSubject,
        openedAt: ticket.createdAt,
        closedAt: null,
        lastActivityAt: ticket.createdAt,
        status: 'open',
        email,
        name: ticket.name,
        product: cleanProduct || undefined,
        firmware: cleanFirmware || undefined,
      };
      await addTicket(env, meta).catch((err) =>
        console.warn('[support/start] ticket-index write failed', err),
      );
      const opening = {
        id: `opening:${thread.id}`,
        author: firstNameOnly(name),
        body: cleanMessage.content || '[attachment]',
      };
      const queued = await queueOdooMessage(env, meta.tid, opening).catch((err) => {
        console.warn('[support/start] Odoo queue write failed', err);
        return null;
      });
      if (!queued) meta.odooPending = [opening];
      const odooRef = await flushOdooMirror(env, meta);

      try {
        const token = await signResumeToken(env, {
          tid: thread.id,
          uid: ticket.uid,
          email,
          name: ticket.name,
          pid,
        });
        const baseUrl = new URL(request.url).origin;
        const resumeUrl = buildResumeUrl(baseUrl, token);
        await sendResumeLink(env, {
          to: email,
          name,
          subject: ticketSubject,
          resumeUrl,
          odooRef: odooRef ?? undefined,
        });
      } catch (err) {
        console.warn('[support/start] resume-email failed', err);
      }
    })();
    if (context.waitUntil) context.waitUntil(backgroundJob);
    else void backgroundJob;

    return data<StartResult>(
      {ok: true, ticketId: ticket.uid, pid},
      {
        status: 200,
        headers: {'Set-Cookie': buildSupportSetCookie(cookie)},
      },
    );
  } catch (err) {
    console.error('[support/start] failed', err);
    return data<StartResult>(
      {
        ok: false,
        message:
          'Could not reach support right now. Try again in a moment or join us on Discord.',
      },
      {status: 502},
    );
  }
}

export function loader() {
  return new Response(null, {status: 404});
}

// IPv4: drop last octet. IPv6: drop last 80 bits. Keeps enough signal for
// abuse triage without storing a full address in the forum post.
function anonymizeIp(ip: string): string {
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return parts.slice(0, 3).join(':') + '::/48';
  }
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  return 'unknown';
}
