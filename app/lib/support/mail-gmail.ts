/**
 * Gmail API client for the mail intake, no dependencies.
 *
 * Auth is a Google service account with domain-wide delegation, impersonating
 * one mailbox (SUPPORT_MAIL_MAILBOX). Scopes: gmail.readonly in dry mode;
 * gmail.readonly plus gmail.compose when drafts are created (mode "1").
 * The service account key is the Worker secret SUPPORT_MAIL_SA_JSON (the
 * downloaded key file, unchanged). The Worker signs the JWT itself with
 * WebCrypto (RS256) and exchanges it for an access token held in memory for
 * its lifetime.
 *
 * The client has three functions: list, get, createDraft. The only write is
 * POST users/{mailbox}/drafts. There is no send function and no code path
 * to messages/send or drafts/send: a human sends from Gmail. Processed
 * messages are tracked in D1 (migrations/0007, 0008), not by a Gmail label.
 */
import {devOverride} from './dev-overrides.ts';
import type {MailMessage} from './mail-parse.ts';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users';
const MAX_BODY_BYTES = 200_000;
/** Base64 characters that decode to MAX_BODY_BYTES (a multiple of 4). */
const MAX_BODY_CHARS = Math.ceil((MAX_BODY_BYTES * 4) / 3 / 4) * 4;
/** A text part larger than this is not decoded at all. */
const MAX_PART_BYTES = 2_000_000;

export type GmailEnv = {
  SUPPORT_MAIL_SA_JSON?: string;
  SUPPORT_MAIL_MAILBOX?: string;
  /** Dev server only (compiled out of a build): a local Gmail stub, see scripts/support-sandbox.mjs. */
  SUPPORT_DEV_GMAIL_API?: string;
};

export type GmailListItem = {id: string; threadId: string};

export type GmailClient = {
  /** Newest first; follows page tokens until `max` ids. */
  list(query: string, max: number): Promise<GmailListItem[]>;
  get(id: string): Promise<MailMessage>;
  /** Save a reply draft in the thread; the id of the Gmail draft. Needs the compose scope. */
  createDraft(threadId: string, raw: string): Promise<string>;
};

/** The scopes a pass asks for: compose only when it creates drafts. */
export const gmailScopes = (compose: boolean): string => (compose ? `${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}` : GMAIL_READONLY_SCOPE);

function sandboxBase(env: GmailEnv): string | null {
  return typeof import.meta.env !== 'undefined' && import.meta.env.DEV ? devOverride(env.SUPPORT_DEV_GMAIL_API) : null;
}

/** Credentials present (or the dev stub): the poll can run. */
export function gmailConfigured(env: GmailEnv): boolean {
  return Boolean(sandboxBase(env) || (env.SUPPORT_MAIL_SA_JSON && env.SUPPORT_MAIL_MAILBOX));
}

type ServiceAccountKey = {client_email: string; private_key: string; token_uri?: string};

function parseKey(raw: string | undefined): ServiceAccountKey {
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(raw ?? '') as Partial<ServiceAccountKey>;
  } catch {
    throw new Error('SUPPORT_MAIL_SA_JSON is not JSON');
  }
  if (!key.client_email || !key.private_key) throw new Error('SUPPORT_MAIL_SA_JSON lacks client_email or private_key');
  return key as ServiceAccountKey;
}

const b64url = (data: ArrayBuffer | Uint8Array | string): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** The signed JWT assertion for the token endpoint (exported for tests). */
export async function signAssertion(key: ServiceAccountKey, subject: string, nowSec: number, scope: string = GMAIL_READONLY_SCOPE): Promise<string> {
  const header = b64url(JSON.stringify({alg: 'RS256', typ: 'JWT'}));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: subject,
      scope,
      aud: key.token_uri ?? 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3000,
    }),
  );
  const signing = `${header}.${claims}`;
  const priv = await crypto.subtle.importKey('pkcs8', pemToDer(key.private_key), {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(signing));
  return `${signing}.${b64url(sig)}`;
}

let cachedToken: {value: string; expires: number; subject: string; scope: string} | null = null;
export function _resetGmailToken() {
  cachedToken = null;
}

async function accessToken(env: GmailEnv, fetcher: typeof fetch, now: number, scope: string): Promise<string> {
  if (sandboxBase(env)) return 'sandbox';
  const subject = env.SUPPORT_MAIL_MAILBOX!;
  if (cachedToken && cachedToken.subject === subject && cachedToken.scope === scope && cachedToken.expires > now + 60_000) return cachedToken.value;
  const key = parseKey(env.SUPPORT_MAIL_SA_JSON);
  const assertion = await signAssertion(key, subject, Math.floor(now / 1000), scope);
  const res = await fetcher(key.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion}),
    signal: AbortSignal.timeout(8000),
  });
  // The body names the cause (unauthorized_client: scope or client id not delegated). It holds no secret.
  if (!res.ok) throw new Error(`gmail token ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = (await res.json()) as {access_token?: string; expires_in?: number};
  if (!json.access_token) throw new Error('gmail token response without access_token');
  cachedToken = {value: json.access_token, expires: now + (json.expires_in ?? 3000) * 1000, subject, scope};
  return json.access_token;
}

// --------------------------------------------------------------------------
// Message parsing
// --------------------------------------------------------------------------

type Part = {
  mimeType?: string;
  filename?: string;
  headers?: Array<{name: string; value: string}>;
  body?: {size?: number; data?: string; attachmentId?: string};
  parts?: Part[];
};

type ApiMessage = {id: string; threadId: string; labelIds?: string[]; internalDate?: string; payload?: Part};

function decodeBase64Url(data: string): Uint8Array {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function charsetOf(part: Part): string {
  const ct = (part.headers ?? []).find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  return ct.match(/charset="?([\w-]+)"?/i)?.[1] ?? 'utf-8';
}

function decodePart(part: Part): string {
  const data = part.body?.data;
  if (!data || (part.body?.size ?? 0) > MAX_PART_BYTES) return '';
  // Cut the base64 before decoding: a huge part never becomes a huge array.
  const bytes = decodeBase64Url(data.slice(0, MAX_BODY_CHARS)).slice(0, MAX_BODY_BYTES);
  try {
    return new TextDecoder(charsetOf(part), {fatal: false}).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** The API's message resource as the rules see it. Exported for tests. */
export function toMailMessage(api: ApiMessage): MailMessage {
  const headers: Record<string, string[]> = {};
  for (const h of api.payload?.headers ?? []) (headers[h.name.toLowerCase()] ??= []).push(h.value);
  let text: string | null = null;
  let html: string | null = null;
  let attachmentCount = 0;
  const walk = (part: Part, depth: number) => {
    if (depth > 8) return;
    if (part.filename && (part.body?.attachmentId || part.body?.size)) attachmentCount++;
    else if (part.mimeType === 'text/plain' && text === null) text = decodePart(part);
    else if (part.mimeType === 'text/html' && html === null) html = decodePart(part);
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  if (api.payload) walk(api.payload, 0);
  return {
    id: api.id,
    threadId: api.threadId,
    labelIds: api.labelIds ?? [],
    headers,
    text,
    html,
    attachmentCount,
    receivedAt: Number(api.internalDate) || 0,
  };
}

// --------------------------------------------------------------------------
// Client
// --------------------------------------------------------------------------

export function createGmailClient(
  env: GmailEnv,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
  opts: {compose?: boolean} = {},
): GmailClient {
  const compose = opts.compose === true;
  const scope = gmailScopes(compose);
  const base = sandboxBase(env) ?? `${GMAIL_API}/${encodeURIComponent(env.SUPPORT_MAIL_MAILBOX ?? 'me')}`;

  async function call<T>(path: string, post?: unknown): Promise<T> {
    const token = await accessToken(env, fetcher, now(), scope);
    const res = await fetcher(`${base}${path}`, {
      method: post === undefined ? 'GET' : 'POST',
      headers: {Authorization: `Bearer ${token}`, ...(post === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(post === undefined ? {} : {body: JSON.stringify(post)}),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`gmail ${path.split('?')[0]} ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async list(query, max) {
      const out: GmailListItem[] = [];
      let page = '';
      while (out.length < max) {
        const qs = new URLSearchParams({q: query, maxResults: String(Math.min(100, max - out.length))});
        if (page) qs.set('pageToken', page);
        const json = await call<{messages?: GmailListItem[]; nextPageToken?: string}>(`/messages?${qs}`);
        out.push(...(json.messages ?? []));
        if (!json.nextPageToken) break;
        page = json.nextPageToken;
      }
      return out.slice(0, max);
    },
    async get(id) {
      return toMailMessage(await call<ApiMessage>(`/messages/${encodeURIComponent(id)}?format=full`));
    },
    async createDraft(threadId, raw) {
      if (!compose) throw new Error('gmail client created without the compose scope');
      const json = await call<{id?: string}>('/drafts', {message: {threadId, raw}});
      if (!json.id) throw new Error('gmail draft response without id');
      return json.id;
    },
  };
}
