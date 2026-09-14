/**
 * Odoo support-ticket mirror (erp PLAN.md step 12.2, `addons/incutec_support`).
 *
 * Every Discord support ticket this bridge creates, and every message a
 * visitor sends into it, is mirrored into an Odoo `project.task` so staff
 * see the same ticket in the ERP. Contract:
 * erp/addons/incutec_support/README.md ("Bridge contract"):
 *
 *   POST {SUPPORT_ODOO_URL}/incutec/support/ticket
 *     {thread_id, email, name, subject} -> {id, ticket_ref, created}
 *   POST {SUPPORT_ODOO_URL}/incutec/support/ticket/<ref>/message
 *     {author, body} -> {id, ticket_ref, posted}
 *
 * Both are idempotent / additive on the Odoo side and authenticated with
 * X-Incutec-Support-Token.
 *
 * D13 (docs/storefront-contract.md, erp/PLAN.md): the storefront's Discord
 * flow does not change shape for the visitor. This module is therefore
 * best-effort by design — a network error or an Odoo outage never throws,
 * never delays the Discord response, and never surfaces to the visitor.
 * Every call here does at most one retry, then logs a warning and resolves
 * to `null` / `false` so the caller can carry on with the Discord-only path.
 */

import {
  acknowledgeOdooMessage,
  listOdooMessages,
  patchMeta,
  queueOdooMessage,
  type TicketMeta,
} from './ticket-index.ts';

const DEFAULT_ODOO_URL = 'https://erp.incutec.eu';
const ODOO_TIMEOUT_MS = 5000;

type OdooEnv = {
  SUPPORT_ODOO_URL?: string;
  SUPPORT_ODOO_TOKEN?: string;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
};

export type OdooTicket = {
  id: number;
  ticketRef: string;
  created: boolean;
  posted: boolean;
};

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
// (bad request, unauthorized, not found) is not — retrying would just
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
// call ultimately fails — callers must not block the Discord path on it.
export async function createOrFetchOdooTicket(
  env: OdooEnv,
  opts: {
    threadId: string;
    email: string;
    name: string;
    subject: string;
    author?: string;
    body?: string;
    messageId?: string;
  },
): Promise<OdooTicket | null> {
  if (!env.SUPPORT_ODOO_TOKEN) return null;
  const res = await callOdoo(env, '/incutec/support/ticket', {
    thread_id: opts.threadId,
    email: opts.email,
    name: opts.name,
    subject: opts.subject,
    author: opts.author,
    body: opts.body,
    message_id: opts.messageId,
  });
  if (!res) return null;
  if (!res.ok) {
    console.warn('[support/odoo] ticket create/fetch', res.status);
    return null;
  }
  try {
    const json = (await res.json()) as {
      id: number;
      ticket_ref: string;
      created: boolean;
      posted?: boolean;
    };
    return {
      id: json.id,
      ticketRef: json.ticket_ref,
      created: json.created,
      posted: json.posted === true,
    };
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
  opts: {ticketRef: string; author: string; body: string; messageId?: string},
): Promise<boolean> {
  if (!env.SUPPORT_ODOO_TOKEN) return false;
  const res = await callOdoo(
    env,
    `/incutec/support/ticket/${encodeURIComponent(opts.ticketRef)}/message`,
    {author: opts.author, body: opts.body, message_id: opts.messageId},
  );
  if (!res) return false;
  if (!res.ok) {
    console.warn('[support/odoo] message relay', res.status);
    return false;
  }
  const json = (await res.json().catch(() => null)) as {posted?: boolean} | null;
  return typeof json?.posted === 'boolean';
}

export async function flushOdooMirror(
  env: OdooEnv,
  ticket: TicketMeta,
): Promise<string | null> {
  let ref = ticket.odooRef;
  // Move records from the first outbox format into independent, atomic keys.
  // SET NX makes retries harmless; clearing the legacy field prevents those
  // records from being recreated after their independent keys are acked.
  if (ticket.odooPending?.length) {
    for (const message of ticket.odooPending) {
      await queueOdooMessage(env, ticket.tid, message);
    }
    await patchMeta(env, ticket.tid, {odooPending: undefined});
  }
  let pending = await listOdooMessages(env, ticket.tid);
  if (!ref) {
    const opening = pending[0];
    const created = await createOrFetchOdooTicket(env, {
      threadId: ticket.tid,
      email: ticket.email,
      name: ticket.name,
      subject: ticket.subject,
      author: opening?.author,
      body: opening?.body,
      messageId: opening?.id,
    });
    if (!created) return null;
    ref = created.ticketRef;
    await patchMeta(env, ticket.tid, {odooRef: ref});
    if (opening) {
      await acknowledgeOdooMessage(env, ticket.tid, opening.id);
      pending = pending.slice(1);
    }
  }
  for (const message of pending) {
    const settled = await postOdooMessage(env, {
      ticketRef: ref,
      author: message.author,
      body: message.body,
      messageId: message.id,
    });
    if (!settled) break;
    await acknowledgeOdooMessage(env, ticket.tid, message.id);
  }
  return ref;
}
