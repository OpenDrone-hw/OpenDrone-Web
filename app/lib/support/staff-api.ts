/**
 * The staff API of the support CRM: /api/staff/support/*, for the internal
 * app. Behind SUPPORT_CRM_API (404 while off). One handler, one route table;
 * the rules live in crm.ts, community.ts and tickets.ts. Every write is
 * audited with the X-Staff-Login header (support_audit).
 */
import {approvedText} from './ai-drafts.ts';
import {routeHint, takeOver, syncCommunity} from './community.ts';
import {addInternalNote, applyChanges, customerCard, parseChanges, sendStaffReply, MAX_NOTE} from './crm.ts';
import {fileResponse, isR2Attachment} from './files.ts';
import {communityEnabled, crmEnabled, hasThread} from './flags.ts';
import {authenticateStaff, type StaffAuthEnv} from './staff-auth.ts';
import {PRIORITIES, type Priority, type ReplyKey, type Route, type Ticket, type TicketFilter, type TicketMessage, type TicketStatus} from './store.ts';
import {supportDeps, supportReady, type SupportWorkerEnv} from './server.ts';
import {parseTicketRef} from './tokens.ts';
import {TOPICS, normalizeText, sendConfirmation, type Deps} from './tickets.ts';
import {extractAttachments} from './uploads.ts';

export const STAFF_BASE = '/api/staff/support';
const PAGE = 50;
const JSON_LIMIT = 64 * 1024;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ok: false, error, ...extra}, status);

type StaffEnv = SupportWorkerEnv & StaffAuthEnv;

// ---- serialisation: what the app sees ----

export function staffTicket(t: Ticket, customerTexts: string[] = []) {
  return {
    ref: t.ref,
    subject: t.subject,
    preview: t.preview,
    topic: t.topic,
    status: t.status,
    route: t.route,
    assignee: t.assignee,
    priority: t.priority,
    tags: t.tags,
    name: t.name,
    email: t.email,
    orderNumber: t.orderNumber,
    orderVerified: t.orderVerified,
    product: t.product,
    customerMatch: t.customerMatch,
    locked: t.locked,
    communityConsent: t.communityConsent,
    inCommunity: t.communityPostId !== null,
    // The forum post (a Discord thread id, no personal data) so staff can open it; null until posted.
    communityPostId: t.communityPostId,
    // A suggestion from the hard rules alone, never an action: {route, reason}.
    routeHint: routeHint(t, [t.subject, t.preview, t.product ?? '', ...customerTexts]),
    hasDiscordThread: hasThread(t),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastCustomerAt: t.lastCustomerAt,
    lastStaffAt: t.lastStaffAt,
    lastCommunityAt: t.lastCommunityAt,
    closedAt: t.closedAt,
  };
}

export function staffMessage(m: TicketMessage) {
  return {
    seq: m.seq,
    role: m.role,
    author: m.author,
    body: m.body,
    at: m.createdAt,
    answer: m.answer,
    attachments: m.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      // Files of a ticket from before the CRM stay on Discord (href null).
      href: isR2Attachment(a) ? `${STAFF_BASE}/tickets/${m.ref}/files/${a.id}` : null,
    })),
  };
}

// ---- request helpers ----

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (text.length > JSON_LIMIT) return null;
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const csv = (v: string | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

async function digest(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function filterOf(q: URLSearchParams): TicketFilter {
  const f: TicketFilter = {};
  const status = csv(q.get('status')).filter((s): s is TicketStatus => ['open', 'waiting', 'answered', 'closed'].includes(s));
  if (status.length) f.status = status;
  const route = q.get('route');
  if (route === 'team' || route === 'community') f.route = route as Route;
  const assignee = q.get('assignee');
  if (assignee && /^[A-Za-z0-9._@+-]{1,64}$|^none$/.test(assignee)) f.assignee = assignee;
  const priority = q.get('priority');
  if (PRIORITIES.includes(priority as Priority)) f.priority = priority as Priority;
  const topic = q.get('topic');
  if (TOPICS.includes(topic as (typeof TOPICS)[number])) f.topic = topic as TicketFilter['topic'];
  const tag = q.get('tag')?.trim().toLowerCase();
  if (tag && tag.length <= 30) f.tag = tag;
  const text = q.get('q')?.trim();
  if (text) f.q = text.slice(0, 80);
  return f;
}

// ---- the handler ----

export type StaffOptions = {origin: string; defer?: (p: Promise<unknown>) => void; fetcher?: typeof fetch; /** Tests: dependencies built by hand. */ deps?: Deps};

export async function handleStaff(request: Request, env: StaffEnv, opts: StaffOptions): Promise<Response> {
  const {fetcher} = opts;
  if (!crmEnabled(env)) return new Response('Not found', {status: 404, headers: {'Cache-Control': 'no-store'}});
  const auth = await authenticateStaff(request, env, fetcher);
  if (!auth.ok) {
    return new Response(JSON.stringify({ok: false, error: auth.error}), {
      status: auth.status,
      headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(auth.status === 401 ? {'WWW-Authenticate': 'Bearer'} : {})},
    });
  }
  if (!opts.deps && !supportReady(env)) return fail(503, 'support_not_configured');

  const url = new URL(request.url);
  const path = url.pathname.slice(STAFF_BASE.length).replace(/^\/+|\/+$/g, '');
  const seg = path ? path.split('/') : [];
  const method = request.method.toUpperCase();
  const write = method !== 'GET' && method !== 'HEAD';
  if (write && !auth.login) return fail(400, 'staff_login_required');
  const login = auth.login ?? '';
  const deps: Deps = opts.deps ?? {...supportDeps(env, opts.origin, opts.defer), fetcher};
  const now = (deps.now ?? Date.now)();

  // /status
  if (seg[0] === 'status' && seg.length === 1 && method === 'GET') {
    return json({ok: true, crm: true, communityRoute: communityEnabled(env), files: Boolean(deps.files), drafts: Boolean(deps.chatfpv)});
  }

  // /saved-replies
  if (seg[0] === 'saved-replies') {
    if (seg.length === 1 && method === 'GET') return json({ok: true, replies: await deps.store.savedReplies()});
    if (seg.length === 1 && method === 'POST') {
      const b = await readJson(request);
      const title = typeof b?.title === 'string' ? b.title.trim() : '';
      const body = typeof b?.body === 'string' ? normalizeText(b.body) : '';
      if (!title || title.length > 80 || !body || body.length > 8000) return fail(400, 'invalid_reply');
      const reply = await deps.store.createSavedReply(title, body, login, now);
      await deps.store.audit(login, 'saved_reply_create', null, `id=${reply.id}`, now);
      return json({ok: true, reply}, 201);
    }
    const id = Number(seg[1]);
    if (seg.length === 2 && Number.isInteger(id) && id > 0) {
      if (method === 'PUT') {
        const b = await readJson(request);
        const title = typeof b?.title === 'string' ? b.title.trim() : '';
        const body = typeof b?.body === 'string' ? normalizeText(b.body) : '';
        if (!title || title.length > 80 || !body || body.length > 8000) return fail(400, 'invalid_reply');
        if (!(await deps.store.updateSavedReply(id, title, body, login, now))) return fail(404, 'not_found');
        await deps.store.audit(login, 'saved_reply_update', null, `id=${id}`, now);
        return json({ok: true, reply: await deps.store.savedReply(id)});
      }
      if (method === 'DELETE') {
        if (!(await deps.store.deleteSavedReply(id))) return fail(404, 'not_found');
        await deps.store.audit(login, 'saved_reply_delete', null, `id=${id}`, now);
        return json({ok: true});
      }
    }
    return fail(405, 'method_not_allowed');
  }

  if (seg[0] !== 'tickets') return fail(404, 'not_found');

  // /tickets
  if (seg.length === 1) {
    if (method !== 'GET') return fail(405, 'method_not_allowed');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || PAGE, 1), 100);
    const before = Number(url.searchParams.get('before'));
    const rows = await deps.store.listTickets(filterOf(url.searchParams), limit + 1, Number.isFinite(before) && before > 0 ? before : undefined);
    const page = rows.slice(0, limit);
    return json({ok: true, tickets: page.map((t) => staffTicket(t)), next: rows.length > limit ? page[page.length - 1]!.updatedAt : null});
  }

  const ref = parseTicketRef(seg[1]);
  if (!ref) return fail(404, 'not_found');
  let ticket = await deps.store.getTicket(ref);
  if (!ticket) return fail(404, 'not_found');
  const sub = seg[2];

  // /tickets/:ref
  if (seg.length === 2) {
    if (method === 'GET') {
      ticket = await syncCommunity(deps, ticket);
      const pending = deps.chatfpv ? await deps.chatfpv.drafts.pending(ref) : [];
      const messages = await deps.store.messages(ref);
      return json({
        ok: true,
        ticket: staffTicket(ticket, messages.filter((m) => m.role === 'customer').map((m) => m.body)),
        messages: messages.map(staffMessage),
        notes: await deps.store.notes(ref),
        drafts: pending.map((d) => ({draftId: d.draftId, body: d.body, text: approvedText(d), citations: d.citations, createdAt: d.createdAt})),
        audit: await deps.store.auditFor(ref, 50),
      });
    }
    if (method === 'PATCH') {
      const parsed = parseChanges(await readJson(request));
      if (!parsed.ok) return fail(400, 'invalid_field', {field: parsed.field});
      const next = await applyChanges(deps, ticket, parsed.changes, login);
      return json({ok: true, ticket: staffTicket(next)});
    }
    return fail(405, 'method_not_allowed');
  }

  if (seg.length === 3 && sub === 'customer' && method === 'GET') return json({ok: true, customer: await customerCard(deps, ticket)});

  // Send the ticket-received mail again to the address on the ticket (one click of a person; audited).
  if (seg.length === 3 && sub === 'resend-confirmation' && method === 'POST') {
    const sent = await sendConfirmation(deps, ticket, login);
    return sent ? json({ok: true, sent: true}) : fail(502, 'mail_not_sent');
  }

  if (seg.length === 3 && sub === 'draft' && method === 'GET') {
    const pending = deps.chatfpv ? await deps.chatfpv.drafts.pending(ref) : [];
    const d = pending[pending.length - 1];
    return json({ok: true, draft: d ? {draftId: d.draftId, body: d.body, text: approvedText(d), citations: d.citations, createdAt: d.createdAt} : null});
  }

  if (seg.length === 3 && sub === 'notes' && method === 'POST') {
    const b = await readJson(request);
    const note = typeof b?.body === 'string' ? await addInternalNote(deps, ticket, login, b.body) : null;
    return note ? json({ok: true, note}, 201) : fail(400, 'invalid_note', {max: MAX_NOTE});
  }

  if (seg.length === 3 && sub === 'reply' && method === 'POST') {
    const key = request.headers.get('Idempotency-Key');
    if (key !== null && !/^[\x21-\x7e]{1,255}$/.test(key)) return fail(400, 'invalid_idempotency_key');
    let body = '';
    let draftId: string | undefined;
    let status: 'answered' | 'waiting' | undefined;
    let files: Awaited<ReturnType<typeof extractAttachments>> = {ok: true, files: []};
    let authorName: string | undefined;
    if ((request.headers.get('Content-Type') ?? '').includes('multipart/form-data')) {
      const form = await request.formData();
      body = String(form.get('body') ?? '');
      draftId = String(form.get('draftId') ?? '') || undefined;
      status = form.get('status') === 'waiting' ? 'waiting' : undefined;
      authorName = String(form.get('authorName') ?? '') || undefined;
      files = await extractAttachments(form);
    } else {
      const b = await readJson(request);
      if (!b || typeof b.body !== 'string') return fail(400, 'invalid_reply');
      body = b.body;
      draftId = typeof b.draftId === 'string' ? b.draftId : undefined;
      status = b.status === 'waiting' ? 'waiting' : undefined;
      authorName = typeof b.authorName === 'string' ? b.authorName : undefined;
    }
    if (!files.ok) return fail(400, `file_${files.problem}`, {file: files.file});
    let idempotency: ReplyKey | undefined;
    if (key !== null) {
      const attachments = await Promise.all(files.files.map(async (f) => ({name: f.name, type: f.type, hash: await digest(f.data)})));
      idempotency = {
        keyHash: await digest(key),
        requestHash: await digest(JSON.stringify({ref, login, body, draftId: draftId || null, status: status ?? 'answered', authorName: authorName || null, attachments})),
      };
    }
    const result = await sendStaffReply(deps, ticket, {login, author: authorName, body, draftId, status, files: files.files, idempotency});
    if (!result.ok) return fail(result.error === 'locked' || result.error === 'idempotency_conflict' ? 409 : result.error === 'files_unavailable' ? 503 : 422, result.error);
    return json({ok: true, ticket: staffTicket(result.ticket), message: result.message ? staffMessage(result.message) : null}, 201);
  }

  if (seg.length === 3 && sub === 'takeover' && method === 'POST') {
    if (ticket.route !== 'community') return fail(409, 'not_a_community_ticket');
    const next = await takeOver(deps, ticket, login);
    await deps.store.audit(login, 'takeover', ref, '', now);
    return json({ok: true, ticket: staffTicket(next)});
  }

  if (seg.length === 5 && sub === 'messages' && seg[4] === 'answer' && (method === 'POST' || method === 'DELETE')) {
    const seq = Number(seg[3]);
    if (!Number.isInteger(seq) || seq < 1) return fail(404, 'not_found');
    if (!(await deps.store.markAnswer(ref, seq, method === 'POST'))) return fail(409, 'not_a_community_reply');
    if (method === 'POST' && ticket.status === 'open') {
      await deps.store.updateTicket(ref, {status: 'answered', updatedAt: now});
      ticket = {...ticket, status: 'answered', updatedAt: now};
    }
    await deps.store.audit(login, method === 'POST' ? 'mark_answer' : 'unmark_answer', ref, `seq=${seq}`, now);
    return json({ok: true, ticket: staffTicket(ticket)});
  }

  if (seg.length === 4 && sub === 'files' && method === 'GET') {
    const att = (await deps.store.messages(ref)).flatMap((m) => m.attachments).find((a) => a.id === seg[3]);
    const res = att && deps.files ? await fileResponse(deps.files, ref, att) : null;
    return res ?? fail(404, 'not_found');
  }

  return fail(404, 'not_found');
}
