/**
 * OpenBrain ticket-API client - phase-1 scaffold. NOT WIRED LIVE.
 *
 * The support backend is moving from "Discord-as-source-of-truth + Odoo-
 * backed ticket state + cookie/magic-link" to OpenBrain's account-bound
 * CRM store (crm.* schema). This is the typed client the support routes
 * will proxy to once `SUPPORT_BACKEND=openbrain`. Today the routes still
 * use the Discord bridge; nothing here is on the request path yet.
 *
 * Trust boundary: this Worker is a confidential first-party client. It verifies
 * the Shopify customer session, then calls OpenBrain with the VERIFIED
 * customer id + the shared key. The browser never reaches OpenBrain directly,
 * and the key never leaves the Worker. OpenBrain enforces per-customer
 * ownership on its side.
 *
 * Wire contract mirrors openbrain/api/tickets.py.
 */

export type OpenBrainEnv = {
  OPENBRAIN_URL?: string;
  OPENBRAIN_API_KEY?: string;
  SUPPORT_BACKEND?: string; // 'discord' (default) | 'openbrain'
};

export type SupportBackend = 'discord' | 'openbrain';

/**
 * Which support backend is active. Defaults to 'discord' so the live routes
 * are unchanged until the cut-over is deliberately flipped via env. Only
 * returns 'openbrain' when the flag is set AND the service is configured.
 */
export function supportBackend(env: OpenBrainEnv): SupportBackend {
  const choice = env.SUPPORT_BACKEND?.trim().toLowerCase();
  if (choice === 'openbrain' && env.OPENBRAIN_URL && env.OPENBRAIN_API_KEY) {
    return 'openbrain';
  }
  return 'discord';
}

export type TicketStatus = 'open' | 'awaiting' | 'progress' | 'resolved';
export type AuthorRole = 'customer' | 'staff' | 'community' | 'ai';

export type OBAttachment = {url: string; filename: string};

export type OBMessage = {
  id: string;
  role: AuthorRole;
  author_name: string;
  body: string;
  created_at: string;
  attachments: OBAttachment[];
};

export type OBTicket = {
  id: string;
  pid: string;
  status: TicketStatus;
  subject: string;
  product?: string | null;
  firmware?: string | null;
  opened_at: string;
  last_activity_at: string;
};

export type OBTicketThread = OBTicket & {messages: OBMessage[]};

export type OBDraft = {
  answer: string;
  citations: Array<Record<string, unknown>>;
  confidence: number;
  escalate: boolean;
};

const TIMEOUT_MS = 5000;

export class OpenBrainError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenBrainError';
    this.status = status;
  }
}

function client(env: OpenBrainEnv): {
  base: string;
  key: string;
} {
  const base = env.OPENBRAIN_URL?.replace(/\/$/, '');
  const key = env.OPENBRAIN_API_KEY;
  if (!base || !key) {
    throw new OpenBrainError('OpenBrain backend is not configured', 503);
  }
  return {base, key};
}

async function call<T>(
  env: OpenBrainEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const {base, key} = client(env);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'X-OpenBrain-Key': key,
        ...(body ? {'Content-Type': 'application/json'} : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OpenBrainError(
      err instanceof Error ? `openbrain fetch failed: ${err.message}` : 'openbrain fetch failed',
      504,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new OpenBrainError(
      `openbrain ${method} ${path} -> ${res.status} ${detail.slice(0, 200)}`,
      res.status,
    );
  }
  return (await res.json()) as T;
}

// ---- ticket operations (proxied by the support routes once flipped) -----

export function createTicket(
  env: OpenBrainEnv,
  input: {
    customerId: string;
    email: string;
    name?: string;
    subject?: string;
    product?: string;
    firmware?: string;
    message: string;
  },
): Promise<OBTicket> {
  return call<OBTicket>(env, 'POST', '/tickets', {
    customer_id: input.customerId,
    email: input.email,
    name: input.name ?? '',
    subject: input.subject ?? '',
    product: input.product ?? null,
    firmware: input.firmware ?? null,
    message: input.message,
  });
}

export function listTickets(
  env: OpenBrainEnv,
  customerId: string,
  status: 'open' | 'closed' | 'all' = 'all',
): Promise<OBTicket[]> {
  const qs = new URLSearchParams({customer_id: customerId, status});
  return call<OBTicket[]>(env, 'GET', `/tickets?${qs.toString()}`);
}

export function getTicket(
  env: OpenBrainEnv,
  tid: string,
  customerId: string,
): Promise<OBTicketThread> {
  const qs = new URLSearchParams({customer_id: customerId});
  return call<OBTicketThread>(env, 'GET', `/tickets/${tid}?${qs.toString()}`);
}

export function sendMessage(
  env: OpenBrainEnv,
  tid: string,
  input: {customerId: string; body?: string; attachments?: OBAttachment[]},
): Promise<OBMessage> {
  return call<OBMessage>(env, 'POST', `/tickets/${tid}/messages`, {
    customer_id: input.customerId,
    body: input.body ?? '',
    attachments: input.attachments ?? [],
  });
}

export function closeTicket(
  env: OpenBrainEnv,
  tid: string,
  customerId: string,
): Promise<OBTicket> {
  return call<OBTicket>(env, 'POST', `/tickets/${tid}/close`, {
    customer_id: customerId,
  });
}

export function requestDraft(
  env: OpenBrainEnv,
  tid: string,
  customerId: string,
): Promise<OBDraft> {
  const qs = new URLSearchParams({customer_id: customerId});
  return call<OBDraft>(env, 'POST', `/tickets/${tid}/draft?${qs.toString()}`);
}
