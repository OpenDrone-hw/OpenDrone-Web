/**
 * Odoo support-ticket bridge (erp PLAN.md step 12.2, `addons/incutec_support`).
 *
 * Every Discord support ticket this bridge creates, and every message a
 * visitor sends into it, is mirrored into an Odoo `project.task` so staff
 * see the same ticket in the ERP. Odoo is also this storefront's ticket
 * state and lookup store (founder decision, 2026-09-15): it replaced a
 * Upstash Redis KV index this module used to keep alongside it - there is
 * no separate KV store any more, `project.task` is the only one. Contract:
 * erp/addons/incutec_support/README.md ("Bridge contract"):
 *
 *   POST {SUPPORT_ODOO_URL}/incutec/support/ticket
 *     {thread_id, email, name, subject, product?, firmware?}
 *     -> {id, ticket_ref, created}
 *   POST {SUPPORT_ODOO_URL}/incutec/support/ticket/<ref>/message
 *     {author, body} -> {id, ticket_ref, posted}
 *   POST {SUPPORT_ODOO_URL}/incutec/support/ticket/<ref>/state
 *     {closed?, seen_cursor?, notify_cursor?, thread_deleted?, feedback?}
 *     -> {id, ticket_ref, ok}
 *   POST {SUPPORT_ODOO_URL}/incutec/support/tickets/search
 *     {thread_id?, email?, status?, limit?} -> {tickets: [...]}
 *
 * All four are idempotent / additive on the Odoo side and authenticated
 * with X-Incutec-Support-Token.
 *
 * D13 (docs/storefront-contract.md, erp/PLAN.md): the storefront's Discord
 * flow does not change shape for the visitor. This module is therefore
 * best-effort by design - a network error or an Odoo outage never throws,
 * never delays the Discord response, and never surfaces to the visitor.
 * Every call here does at most one retry, then logs a warning and resolves
 * to `null` / `false` (or an empty list) so the caller can carry on with
 * the Discord-only path.
 *
 * There is no local cache of `ticket_ref` any more: every write resolves it
 * fresh via `createOrFetchOdooTicket`, which is idempotent and indexed on
 * `discord_thread_id`, so a repeated call for the same thread is a cheap
 * fetch, not a duplicate ticket.
 */

const DEFAULT_ODOO_URL = 'https://erp.incutec.eu';
const ODOO_TIMEOUT_MS = 5000;

type OdooEnv = {
  SUPPORT_ODOO_URL?: string;
  SUPPORT_ODOO_TOKEN?: string;
};

export type OdooTicket = {
  id: number;
  ticketRef: string;
  created: boolean;
};

export type OdooTicketStatus = 'open' | 'closed';

export type OdooTicketSummary = {
  tid: string; // Discord thread id
  ref: string; // Odoo ticket_ref, e.g. "SUP-00001"
  pid: string; // 10-digit public ticket ref shown to the customer
  subject: string;
  email: string;
  name: string;
  openedAt: number; // unix seconds
  closedAt: number | null;
  lastActivityAt: number;
  status: OdooTicketStatus;
  product?: string;
  firmware?: string;
  seenCursor?: string;
  notifyCursor?: string;
};

export type OdooFeedback = {
  speed: number;
  helpfulness: number;
  overall: number;
  notes: string;
};

export function hasOdooBridge(env: OdooEnv): boolean {
  return Boolean(env.SUPPORT_ODOO_TOKEN);
}

function baseUrl(env: OdooEnv): string {
  return (env.SUPPORT_ODOO_URL || DEFAULT_ODOO_URL).replace(/\/+$/, '');
}

function odooFetch(env: OdooEnv, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl(env)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Incutec-Support-Token': env.SUPPORT_ODOO_TOKEN ?? '',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ODOO_TIMEOUT_MS),
  });
}

// At most one retry: a network error or a 5xx is retried once, a 4xx
// (bad request, unauthorized, not found) is not - retrying would just
// repeat the same error. Never throws; a permanent failure resolves to
// `null` after logging a warning, which every caller treats as "Odoo is
// unavailable right now, continue on the Discord-only path".
async function callOdoo(
  env: OdooEnv,
  path: string,
  body: unknown,
): Promise<Response | null> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await odooFetch(env, path, body);
      if (res.ok || res.status < 500) return res;
      lastErr = new Error(`odoo ${path} ${res.status}`);
      if (attempt === 2) {
        console.warn('[support/odoo] request failed after retry', path, res.status);
        return res;
      }
    } catch (err) {
      lastErr = err;
      if (attempt === 2) {
        console.warn('[support/odoo] request failed after retry', path, err);
        return null;
      }
      console.warn('[support/odoo] request failed, retrying once', path, err);
    }
  }
  console.warn('[support/odoo] request failed', path, lastErr);
  return null;
}

// Create or fetch the Odoo ticket for a Discord thread. Idempotent on
// thread_id: a second call for the same thread returns the existing
// ticket (`created: false`) and ignores email/name/subject, matching the
// Odoo contract. Returns `null` when SUPPORT_ODOO_TOKEN is unset or the
// call ultimately fails - callers must not block the Discord path on it.
export async function createOrFetchOdooTicket(
  env: OdooEnv,
  opts: {
    threadId: string;
    email: string;
    name: string;
    subject: string;
    product?: string;
    firmware?: string;
    pid?: string;
  },
): Promise<OdooTicket | null> {
  if (!env.SUPPORT_ODOO_TOKEN) return null;
  const res = await callOdoo(env, '/incutec/support/ticket', {
    thread_id: opts.threadId,
    email: opts.email,
    name: opts.name,
    subject: opts.subject,
    product: opts.product,
    firmware: opts.firmware,
    pid: opts.pid,
  });
  if (!res) return null;
  if (!res.ok) {
    console.warn('[support/odoo] ticket create/fetch', res.status);
    return null;
  }
  try {
    const json = (await res.json()) as {id: number; ticket_ref: string; created: boolean};
    return {id: json.id, ticketRef: json.ticket_ref, created: json.created};
  } catch (err) {
    console.warn('[support/odoo] ticket create/fetch: bad JSON', err);
    return null;
  }
}

// Relay one message onto the ticket named by `ticketRef` (Odoo's
// `ticket_ref`, e.g. "SUP-00001"). Returns whether it posted; never
// throws.
export async function postOdooMessage(
  env: OdooEnv,
  opts: {ticketRef: string; author: string; body: string},
): Promise<boolean> {
  if (!env.SUPPORT_ODOO_TOKEN) return false;
  const res = await callOdoo(
    env,
    `/incutec/support/ticket/${encodeURIComponent(opts.ticketRef)}/message`,
    {author: opts.author, body: opts.body},
  );
  if (!res) return false;
  if (!res.ok) {
    console.warn('[support/odoo] message relay', res.status);
    return false;
  }
  return true;
}

// Patch bridge-owned lifecycle state on a ticket: close it, advance a
// cursor, mark its Discord thread deleted, or record end-of-ticket
// feedback. Replaces the storefront's former Upstash-backed
// closeTicket/patchMeta/saveFeedback/removeTicket. Best-effort like every
// other call here: returns whether the patch was applied, never throws.
export async function patchOdooTicketState(
  env: OdooEnv,
  ticketRef: string,
  patch: {
    closed?: true;
    seenCursor?: string;
    notifyCursor?: string;
    threadDeleted?: true;
    feedback?: OdooFeedback;
  },
): Promise<boolean> {
  if (!env.SUPPORT_ODOO_TOKEN) return false;
  const body: Record<string, unknown> = {};
  if (patch.closed) body.closed = true;
  if (patch.seenCursor !== undefined) body.seen_cursor = patch.seenCursor;
  if (patch.notifyCursor !== undefined) body.notify_cursor = patch.notifyCursor;
  if (patch.threadDeleted) body.thread_deleted = true;
  if (patch.feedback) {
    body.feedback = {
      speed: patch.feedback.speed,
      helpfulness: patch.feedback.helpfulness,
      overall: patch.feedback.overall,
      notes: patch.feedback.notes,
    };
  }
  const res = await callOdoo(
    env,
    `/incutec/support/ticket/${encodeURIComponent(ticketRef)}/state`,
    body,
  );
  if (!res) return false;
  if (!res.ok) {
    console.warn('[support/odoo] state patch', res.status);
    return false;
  }
  return true;
}

// Look up tickets by Discord thread id or customer email - replaces the
// storefront's former Upstash-backed ticket index (listByEmail,
// countOpenForEmail, listAllTickets). Returns an empty list when the
// bridge is unconfigured or the call fails (degrade-soft): callers that
// used to fall back to a Discord forum scan now simply see no tickets,
// documented at each call site.
export async function searchOdooTickets(
  env: OdooEnv,
  opts: {threadId?: string; email?: string; status?: OdooTicketStatus | 'all'; limit?: number},
): Promise<OdooTicketSummary[]> {
  if (!env.SUPPORT_ODOO_TOKEN) return [];
  const res = await callOdoo(env, '/incutec/support/tickets/search', {
    thread_id: opts.threadId,
    email: opts.email,
    status: opts.status ?? 'all',
    limit: opts.limit,
  });
  if (!res || !res.ok) {
    if (res) console.warn('[support/odoo] tickets search', res.status);
    return [];
  }
  try {
    const json = (await res.json()) as {
      tickets: Array<{
        thread_id: string;
        ticket_ref: string;
        pid?: string | null;
        subject: string;
        email: string;
        name: string;
        opened_at: number | null;
        closed_at: number | null;
        last_activity_at: number | null;
        status: OdooTicketStatus;
        product?: string | null;
        firmware?: string | null;
        seen_cursor?: string | null;
        notify_cursor?: string | null;
      }>;
    };
    return json.tickets.map((t) => ({
      tid: t.thread_id,
      ref: t.ticket_ref,
      pid: t.pid || t.ticket_ref,
      subject: t.subject,
      email: t.email,
      name: t.name,
      openedAt: t.opened_at ?? 0,
      closedAt: t.closed_at,
      lastActivityAt: t.last_activity_at ?? t.opened_at ?? 0,
      status: t.status,
      product: t.product ?? undefined,
      firmware: t.firmware ?? undefined,
      seenCursor: t.seen_cursor ?? undefined,
      notifyCursor: t.notify_cursor ?? undefined,
    }));
  } catch (err) {
    console.warn('[support/odoo] tickets search: bad JSON', err);
    return [];
  }
}
