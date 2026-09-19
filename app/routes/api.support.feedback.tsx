import {data} from 'react-router';
import type {Route} from './+types/api.support.feedback';
import {postFeedback} from '~/lib/support/discord';
import {readSupportCookie, verifyTicket} from '~/lib/support/session';
import {checkRateLimit} from '~/lib/rate-limit';
import {createOrFetchOdooTicket, patchOdooTicketState} from '~/lib/support/odoo';
import {scrubForDiscord} from '~/lib/support/scrubber';

type FeedbackResult =
  | {ok: true}
  | {ok: false; message: string; code?: 'no-ticket' | 'invalid' | 'rate-limited'};

// Stage 6 end-of-ticket survey. Three 1-5 ratings + free-text notes.
// Posts a structured message to DISCORD_FEEDBACK_CHANNEL_ID (falls back
// to staff metadata channel) AND stores the ratings on the mirrored Odoo
// ticket (erp/addons/incutec_support) so they can be rolled up into a
// report there. Idempotent - submitting twice overwrites, which keeps the
// UX simple ("oops, wanted to fix my rating") at the cost of losing the
// prior submission.
export async function action({request, context}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return data<FeedbackResult>(
      {ok: false, message: 'Method not allowed.'},
      {status: 405},
    );
  }
  const env = context.env;
  const cookie = readSupportCookie(request);
  const ticket = await verifyTicket(env, cookie);
  if (!ticket) {
    return data<FeedbackResult>(
      {ok: false, message: 'No active ticket.', code: 'no-ticket'},
      {status: 401},
    );
  }

  // Per-ticket cap to discourage repeated re-submissions / scripting.
  const limit = checkRateLimit(`support-feedback:${ticket.uid}`, 3, 60 * 1000);
  if (!limit.allowed) {
    return data<FeedbackResult>(
      {ok: false, message: 'Slow down a moment.', code: 'rate-limited'},
      {
        status: 429,
        headers: {'Retry-After': String(limit.resetInSeconds)},
      },
    );
  }

  const form = await request.formData();
  const speed = parseRating(form.get('speed'));
  const helpfulness = parseRating(form.get('helpfulness'));
  const overall = parseRating(form.get('overall'));
  if (speed === null || helpfulness === null || overall === null) {
    return data<FeedbackResult>(
      {ok: false, message: 'Ratings must be 1-5.', code: 'invalid'},
      {status: 400},
    );
  }

  const rawNotes = String(form.get('notes') ?? '')
    .trim()
    .slice(0, 1500);
  const notes = scrubForDiscord(rawNotes).content;

  const odooJob = (async () => {
    const odooTicket = await createOrFetchOdooTicket(env, {
      threadId: ticket.tid,
      email: ticket.email,
      name: ticket.name,
      subject: `Support ticket #${ticket.pid ?? ticket.uid}`,
    });
    if (odooTicket) {
      await patchOdooTicketState(env, odooTicket.ticketRef, {
        feedback: {speed, helpfulness, overall, notes},
      });
    }
  })().catch((err) => console.warn('[support/feedback] odoo save failed', err));

  const discordJob = postFeedback(env, {
    pid: ticket.pid ?? ticket.uid,
    threadId: ticket.tid,
    customerName: ticket.name,
    customerEmail: ticket.email,
    speed,
    helpfulness,
    overall,
    notes,
  }).catch((err) =>
    console.warn('[support/feedback] discord post failed', err),
  );

  if (context.waitUntil) {
    context.waitUntil(odooJob);
    context.waitUntil(discordJob);
  } else {
    void odooJob;
    void discordJob;
  }

  return data<FeedbackResult>(
    {ok: true},
    {headers: {'Cache-Control': 'no-store'}},
  );
}

export function loader() {
  return new Response(null, {status: 404});
}

function parseRating(raw: FormDataEntryValue | null): number | null {
  if (raw === null) return null;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1 || n > 5) return null;
  return n;
}
