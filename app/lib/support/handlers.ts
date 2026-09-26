/**
 * The two support form actions, shared by the page routes (a plain form
 * POST, no JavaScript) and the JSON endpoints the pages use with JavaScript
 * (`POST /api/support/new`, `POST /api/support/tickets/<ref>`). With
 * JavaScript a failed send stays on the page with every field and file in
 * place; without it the page answers as before.
 */
import type {AppLoadContext} from 'react-router';
import {clientIp} from '../rate-limit.ts';
import {verifyTurnstile} from '../turnstile.ts';
import type {NewTicketInput, FieldError} from './tickets.ts';
import {addCustomerReply, closeTicket, createTicket, parseNewTicket, resetLink} from './tickets.ts';
import {doorAllowed, ticketRateLimit} from './limits.ts';
import {authorizedTicket, originOf, sameOrigin, secureCookies, supportDeps, supportReady} from './server.ts';
import {parseTicketRef, readTicketCookie, withTicket} from './tokens.ts';
import {extractAttachments, type FileProblem} from './uploads.ts';

export type CreateFailure = 'unavailable' | 'rate' | 'turnstile' | 'send' | 'forbidden' | 'files';

export type CreateResult =
  | {ok: true; url: string; at: number}
  | {
      ok: false;
      failure?: CreateFailure;
      file?: {problem: FileProblem; name: string};
      errors?: Partial<Record<keyof NewTicketInput, FieldError>>;
      at: number;
    };

export type Outcome<T> = {status: number; body: T; cookie?: string};

export async function handleCreate(request: Request, context: AppLoadContext): Promise<Outcome<CreateResult>> {
  const env = context.env;
  const fail = (body: Omit<Extract<CreateResult, {ok: false}>, 'ok' | 'at'>, status: number): Outcome<CreateResult> => ({
    status,
    body: {ok: false, at: Date.now(), ...body},
  });

  if (!sameOrigin(request)) return fail({failure: 'forbidden'}, 403);
  if (!supportReady(env)) return fail({failure: 'unavailable'}, 503);
  const ip = clientIp(request);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail({failure: 'send'}, 400);
  }
  // Honeypot: invisible to people.
  if (String(form.get('website') ?? '') !== '') return fail({failure: 'forbidden'}, 400);

  const parsed = parseNewTicket(form);
  if (!parsed.ok) return fail({errors: parsed.errors}, 400);
  const files = await extractAttachments(form);
  if (!files.ok) return fail({failure: 'files', file: {problem: files.problem, name: files.file ?? ''}}, 400);

  const deps = supportDeps(env, originOf(request), context.waitUntil);
  // Counted only for complete submissions, so fixing a typo never locks anyone out.
  const allowed = await doorAllowed(deps.store, env.SUPPORT_SESSION_SECRET || env.SESSION_SECRET, [
    ['createPerIp', ip],
    ['createPerIpEmail', ip, parsed.input.email],
  ]);
  if (!allowed) return fail({failure: 'rate'}, 429);
  const turnstile = await verifyTurnstile(env, String(form.get('cf-turnstile-response') ?? ''), ip);
  if (!turnstile.ok) return fail({failure: 'turnstile'}, 400);

  try {
    const ticket = await createTicket(deps, parsed.input, files.files);
    const current = await readTicketCookie(env, request);
    const cookie = await withTicket(env, current, {r: ticket.ref, k: ticket.linkVersion}, secureCookies(request));
    return {status: 200, body: {ok: true, url: `/support/t/${ticket.ref}?new=1`, at: Date.now()}, cookie};
  } catch (err) {
    console.error('[support] ticket not created', err instanceof Error ? err.message : 'error');
    return fail({failure: 'send'}, 502);
  }
}

export type TicketActionResult = {
  ok: boolean;
  intent: string;
  error?: string;
  file?: string;
  /** The team locked the conversation: the page switches to its locked state. */
  locked?: boolean;
  at: number;
};

export async function handleTicketAction(
  request: Request,
  context: AppLoadContext,
  refParam: string | undefined,
): Promise<Outcome<TicketActionResult>> {
  const env = context.env;
  const answer = (body: Omit<TicketActionResult, 'at'>, status = 200, cookie?: string): Outcome<TicketActionResult> => ({
    status,
    body: {...body, at: Date.now()},
    cookie,
  });
  const ref = parseTicketRef(refParam);
  if (!sameOrigin(request)) return answer({ok: false, intent: 'unknown', error: 'err_forbidden'}, 403);
  if (!ref || !supportReady(env)) return answer({ok: false, intent: 'unknown', error: 'err_unavailable'}, 404);
  const deps = supportDeps(env, originOf(request), context.waitUntil);
  const {ticket, cookie} = await authorizedTicket(deps, request, ref);
  if (!ticket) return answer({ok: false, intent: 'unknown', error: 'err_forbidden'}, 403);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return answer({ok: false, intent: 'reply', error: 'err_send'}, 400);
  }
  const intent = String(form.get('intent') ?? 'reply');
  if (!ticketRateLimit('write', ref).allowed) return answer({ok: false, intent, error: 'err_rate'}, 429);

  try {
    // Replacing the link stays possible on a locked ticket: the link still
    // opens its history, and its holder may want to revoke that.
    if (intent === 'reset') {
      const next = await resetLink(deps, ticket);
      return answer({ok: true, intent}, 200, await withTicket(env, cookie, {r: ref, k: next.linkVersion}, secureCookies(request)));
    }
    if (ticket.locked) return answer({ok: false, intent, error: 'err_locked', locked: true}, 409);
    if (intent === 'solve') {
      await closeTicket(deps, ticket, 'you');
      return answer({ok: true, intent});
    }
    const files = await extractAttachments(form);
    if (!files.ok) return answer({ok: false, intent, error: `file_${files.problem}`, file: files.file}, 400);
    const result = await addCustomerReply(deps, ticket, String(form.get('message') ?? ''), files.files);
    if (!result.ok) {
      const locked = result.error === 'locked';
      return answer({ok: false, intent, error: `err_${result.error}`, locked}, locked ? 409 : 400);
    }
    return answer({ok: true, intent});
  } catch (err) {
    console.error('[support] ticket action failed', ref, intent, err instanceof Error ? err.message : 'error');
    return answer({ok: false, intent, error: 'err_send'}, 502);
  }
}

/** A handler outcome as a JSON response, for the fetch path. */
export function jsonOutcome<T>(o: Outcome<T>): Response {
  const headers = new Headers({'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'});
  if (o.cookie) headers.append('Set-Cookie', o.cookie);
  return new Response(JSON.stringify(o.body), {status: o.status, headers});
}
