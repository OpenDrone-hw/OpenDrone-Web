/**
 * "You have a new reply" email. Off unless SUPPORT_EMAIL_NOTIFY_ENABLED is
 * '1' (turning it on needs the founder's go). The mail carries the ticket
 * reference and a fresh resume link, never message content, so a
 * forwarded or leaked mail reveals nothing of the conversation.
 */

import {button, escapeHtml, head, para, shell} from '../email-shell.ts';

type Env = {
  SUPPORT_EMAIL_NOTIFY_ENABLED?: string;
  RESEND_API_KEY?: string;
  SUPPORT_FROM_EMAIL?: string;
};

export function notifyEnabled(env: Env): boolean {
  return env.SUPPORT_EMAIL_NOTIFY_ENABLED === '1' && Boolean(env.RESEND_API_KEY);
}

export function replyMail(ref: string, link: string): {subject: string; text: string; html: string} {
  const html = shell({
    title: `New reply on your OpenDrone ticket ${escapeHtml(ref)}`,
    badge: 'Support',
    preheader: `There is a new reply on your support ticket ${escapeHtml(ref)}.`,
    body:
      head(`Ticket ${escapeHtml(ref)}`, 'You have a new reply.') +
      para('Our team answered your support ticket. Open it to read the reply and answer.') +
      para('For your privacy the message itself is only on the ticket page. This is an automatic message; replies to this email are not read.', {small: true, last: true}) +
      button(escapeHtml(link), 'Open the ticket &rarr;'),
  });
  return {
    html,
    subject: `New reply on your OpenDrone ticket ${ref}`,
    text: [
      `There is a new reply on your support ticket ${ref}.`,
      '',
      `Read and answer it here: ${link}`,
      '',
      'For your privacy the message itself is only on the ticket page.',
      'This is an automatic message; replies to this email are not read.',
      '',
      'OpenDrone by Incutec BV',
    ].join('\n'),
  };
}

/** "We have your ticket" email, sent once when a ticket is opened. Carries no message content. */
export function receivedMail(ref: string, link: string): {subject: string; text: string; html: string} {
  const html = shell({
    title: `We received your OpenDrone ticket ${escapeHtml(ref)}`,
    badge: 'Support',
    preheader: `Your support ticket ${escapeHtml(ref)} is open. Keep this email: the link opens it.`,
    body:
      head(`Ticket ${escapeHtml(ref)}`, 'We have your request.') +
      para('Thank you for contacting OpenDrone. Your ticket is open and our team will answer on the ticket page; we also send you an email when there is a reply.') +
      para('Use the button to read the conversation, add details or files, and mark the ticket solved. Keep this email: the link is your way back.') +
      para('For your privacy the message itself is not in this email. This is an automatic message; replies to this email are not read.', {small: true, last: true}) +
      button(escapeHtml(link), 'Open your ticket &rarr;'),
  });
  return {
    html,
    subject: `We received your OpenDrone ticket ${ref}`,
    text: [
      `Thank you for contacting OpenDrone. Your support ticket ${ref} is open.`,
      '',
      'Our team will answer on the ticket page, and we email you when there is a reply.',
      `Open your ticket, add details or files: ${link}`,
      '',
      'Keep this email: the link is your way back.',
      'For your privacy the message itself is not in this email.',
      'This is an automatic message; replies to this email are not read.',
      '',
      'OpenDrone by Incutec BV',
    ].join('\n'),
  };
}

async function sendResend(env: Env, to: string, mail: {subject: string; text: string; html: string}, label: string, ref: string, fetcher: typeof fetch): Promise<boolean> {
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        from: `OpenDrone support <${env.SUPPORT_FROM_EMAIL || 'support@opendrone.be'}>`,
        to: [to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn(`[support] ${label} not sent`, ref, res.status);
    return res.ok;
  } catch {
    console.warn(`[support] ${label} failed`, ref);
    return false;
  }
}

export async function sendReplyNotice(
  env: Env,
  to: string,
  ref: string,
  link: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!notifyEnabled(env)) return false;
  return sendResend(env, to, replyMail(ref, link), 'reply notice', ref, fetcher);
}

/** The ticket-received confirmation. Same switch and sender as the reply notice. */
export async function sendTicketReceived(
  env: Env,
  to: string,
  ref: string,
  link: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!notifyEnabled(env)) return false;
  return sendResend(env, to, receivedMail(ref, link), 'ticket confirmation', ref, fetcher);
}
