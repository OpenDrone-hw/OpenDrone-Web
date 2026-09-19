import {redirect} from 'react-router';
import type {Route} from './+types/support.resume';
import {fetchThreadMessages} from '~/lib/support/discord';
import {
  buildSupportSetCookie,
  signTicket,
  type SupportTicket,
} from '~/lib/support/session';
import {verifyResumeToken} from '~/lib/support/resume-token';
import {checkRateLimit, clientIp} from '~/lib/rate-limit';

/**
 * Cross-device resume endpoint. The user clicks a link from their inbox;
 * we verify the signed token and re-issue the cookie that points back at
 * their existing Discord thread. Then we 302 to /support; the re-issued
 * cookie makes it boot into "active" phase straight away.
 *
 * If the token is malformed, expired, or its thread has been deleted on
 * the Discord side, fall back to /support with a query flag reserved for
 * a future "this link no longer works" notice.
 */

export async function loader({request, context}: Route.LoaderArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get('t');
  const env = context.env;

  // Best-effort per-IP cap. If a resume link ever leaks (email archive
  // scraping, shared screen recording), this keeps it from being turned
  // into a bulk hijack vector - the legitimate user only needs a handful
  // of redemptions. `clientIp()` falls back to "unknown" which buckets
  // all un-identified traffic together, so "unknown" sees the same cap.
  const ip = clientIp(request);
  const rl = checkRateLimit(`support-resume:ip:${ip}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return redirect('/support?support=rate-limited');
  }

  const payload = await verifyResumeToken(env, token);
  if (!payload) {
    return redirect('/support?support=invalid-link');
  }

  // Confirm the thread still exists so we don't drop the user into a
  // chat that 404s on their first poll.
  const probe = await fetchThreadMessages(env, payload.tid, {limit: 1}).catch(
    () => ({thread: null, messages: []}),
  );
  if (!probe.thread) {
    return redirect('/support?support=ticket-gone');
  }

  const ticket: SupportTicket = {
    v: 1,
    tid: payload.tid,
    uid: payload.uid,
    name: payload.name,
    email: payload.email,
    createdAt: payload.iat,
    ...(payload.pid ? {pid: payload.pid} : {}),
  };
  const cookie = await signTicket(env, ticket);
  return redirect('/support?support=resumed', {
    headers: {'Set-Cookie': buildSupportSetCookie(cookie)},
  });
}
