import {data} from 'react-router';
import type {Route} from './+types/api.support.send';
import {firstNameOnly, postToThread} from '~/lib/support/discord';
import {readSupportCookie, verifyTicket} from '~/lib/support/session';
import {extractAttachments} from '~/lib/support/uploads';
import {checkRateLimit} from '~/lib/rate-limit';
import {scrubForDiscord} from '~/lib/support/scrubber';
import {createOrFetchOdooTicket, postOdooMessage} from '~/lib/support/odoo';

type SendResult =
  | {
      ok: true;
      id: string;
      attachments: Array<{url: string; filename: string}>;
    }
  | {
      ok: false;
      message: string;
      code?: 'no-ticket' | 'too-long' | 'files' | 'rate-limited' | 'scrubbed';
    };

export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<SendResult>({ok: false, message: 'Method not allowed.'}, {status: 405});
  }
  const env = context.env;
  const cookie = readSupportCookie(request);
  const ticket = await verifyTicket(env, cookie);
  if (!ticket) {
    return data<SendResult>(
      {ok: false, message: 'No active ticket.', code: 'no-ticket'},
      {status: 401},
    );
  }

  // Per-ticket flood cap: at most 10 messages per minute. Genuine users
  // type far slower; this only bites automation scripted against a
  // captured cookie.
  const limit = checkRateLimit(`support-send:${ticket.uid}`, 10, 60 * 1000);
  if (!limit.allowed) {
    return data<SendResult>(
      {
        ok: false,
        message: 'Slow down. Wait a moment before sending again.',
        code: 'rate-limited',
      },
      {
        status: 429,
        headers: {'Retry-After': String(limit.resetInSeconds)},
      },
    );
  }

  const form = await request.formData();
  const content = String(form.get('content') ?? '').trim();
  const attachments = await extractAttachments(form);
  if (!attachments.ok) {
    return data<SendResult>(
      {ok: false, message: attachments.message, code: 'files'},
      {status: 400},
    );
  }
  if (!content && !attachments.files.length) {
    return data<SendResult>({ok: false, message: 'Empty message.'}, {status: 400});
  }
  if (content.length > 1800) {
    return data<SendResult>(
      {ok: false, message: 'Message too long (max 1800 chars).', code: 'too-long'},
      {status: 400},
    );
  }

  // Inbound scrub before the message touches Discord. See api.support.start
  // for the full rationale - narrower than the outbound Discord->web scrub
  // because users legitimately share their own contact details in support
  // threads.
  const cleanContent = scrubForDiscord(content);
  if (cleanContent.blocked) {
    console.warn(
      '[support] inbound scrub blocked send message',
      cleanContent.reasons.join(','),
    );
    return data<SendResult>(
      {
        ok: false,
        message:
          'Your message was rejected by our safety filter. Try rephrasing without any credentials, tokens, or card numbers.',
        code: 'scrubbed',
      },
      {status: 400},
    );
  }

  // First-name only in the public thread. Helpers see who replied
  // without leaking the customer's last name. Full name + email
  // already live on the staff-metadata channel for the ticket.
  const prefix = `**${firstNameOnly(ticket.name)}:**`;
  const body = cleanContent.content
    ? `${prefix} ${cleanContent.content}`
    : prefix;
  const posted = await postToThread(env, ticket.tid, body, attachments.files);
  if (!posted) {
    return data<SendResult>(
      {ok: false, message: 'Message did not reach support. Try again.'},
      {status: 502},
    );
  }
  // Relay this message onto the mirrored Odoo ticket
  // (erp/addons/incutec_support, PLAN.md 12.2), which also bumps the
  // ticket's last-activity server-side. Fire-and-forget: the message
  // already reached Discord above, so an Odoo outage here can only ever
  // be logged, never surfaced to the visitor (D13). createOrFetchOdooTicket
  // is idempotent and indexed on the Discord thread id, so resolving the
  // ref fresh on every send (no local cache) is a cheap fetch, not a
  // duplicate ticket, and needs no separate KV store to remember it.
  const odooJob = (async () => {
    try {
      const odooTicket = await createOrFetchOdooTicket(env, {
        threadId: ticket.tid,
        email: ticket.email,
        name: ticket.name,
        subject: `Support ticket #${ticket.pid ?? ticket.uid}`,
      });
      if (odooTicket) {
        await postOdooMessage(env, {
          ticketRef: odooTicket.ticketRef,
          author: firstNameOnly(ticket.name),
          body: cleanContent.content || '[attachment]',
        });
      }
    } catch (err) {
      console.warn('[support/send] odoo relay failed', err);
    }
  })();
  if (context.waitUntil) context.waitUntil(odooJob);
  else void odooJob;
  return data<SendResult>({
    ok: true,
    id: posted.id,
    attachments: posted.attachments.map((a) => ({
      url: a.url,
      filename: a.filename,
    })),
  });
}

export function loader() {
  return new Response(null, {status: 404});
}
