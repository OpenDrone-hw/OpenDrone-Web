/**
 * "You have a new reply" email. Off unless SUPPORT_EMAIL_NOTIFY_ENABLED is
 * '1' (turning it on needs the founder's go). The mail carries the ticket
 * reference and a fresh resume link, never message content, so a
 * forwarded or leaked mail reveals nothing of the conversation.
 */

type Env = {
  SUPPORT_EMAIL_NOTIFY_ENABLED?: string;
  RESEND_API_KEY?: string;
  SUPPORT_FROM_EMAIL?: string;
};

export function notifyEnabled(env: Env): boolean {
  return env.SUPPORT_EMAIL_NOTIFY_ENABLED === '1' && Boolean(env.RESEND_API_KEY);
}

export function replyMail(ref: string, link: string): {subject: string; text: string} {
  return {
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

export async function sendReplyNotice(
  env: Env,
  to: string,
  ref: string,
  link: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!notifyEnabled(env)) return false;
  const mail = replyMail(ref, link);
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        from: `OpenDrone support <${env.SUPPORT_FROM_EMAIL || 'support@opendrone.be'}>`,
        to: [to],
        subject: mail.subject,
        text: mail.text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.warn('[support] reply notice not sent', ref, res.status);
    return res.ok;
  } catch {
    console.warn('[support] reply notice failed', ref);
    return false;
  }
}
