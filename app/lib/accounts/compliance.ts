/**
 * Shopify compliance webhooks and the data subject request queue for shared
 * accounts (LEGAL.md C7). The routes are live whenever
 * `SHOPIFY_WEBHOOK_SECRET` is set, independent of `ACCOUNTS_ENABLED`, so data
 * created while accounts were on can still be erased after a flag-off. They
 * are signed with the client secret of the custom app that holds that
 * secret (README "Shared accounts").
 *
 *   customers/redact, customers/delete  erase now; a failed ChatFPV erase
 *                                       becomes a pending queue row + alert
 *   customers/data_request              recorded; the scheduled job builds
 *                                       the export into D1 for the founder CLI
 *   shop/redact                         recorded, nothing else to delete
 *
 * Every accepted delivery answers 200: the queue (`rights_requests`,
 * migration 0006), not Shopify's retries, owns the follow-up. The founder
 * CLI (scripts/accounts/rights.mjs) adds rows with source 'founder'.
 */
import {verifyShopifyHmac} from '../shopify-webhook.ts';
import {opsAlertOnce, purgeOpsAlerts, utcDay, type AlertPoster, type OpsAlertEnv} from '../ops-alerts.ts';
import {accountHeaders, jsonResponse, notFound} from './config.ts';
import {randomToken} from './crypto.ts';
import {exportCustomer, redactCustomer, type RightsEnv} from './rights.ts';

export type ComplianceEnv = RightsEnv & OpsAlertEnv;

export type ComplianceTopic = 'customers/redact' | 'customers/delete' | 'customers/data_request' | 'shop/redact';

export type RequestKind = 'erase' | 'export' | 'shop_redact';

/** Handled requests are kept as the record of what was done (Art 5(2) GDPR) for 3 years. */
export const DONE_RETENTION_MS = 3 * 365 * 24 * 60 * 60 * 1000;
/** Rows worked per scheduled run; the cron runs every 5 minutes. */
const BATCH = 10;

const CLI_HINT = 'Run node scripts/accounts/rights.mjs status.';

/** True when the compliance routes are live. */
export const complianceWebhooksActive = (env: {SHOPIFY_WEBHOOK_SECRET?: string}) => Boolean(env.SHOPIFY_WEBHOOK_SECRET?.trim());

/**
 * `gid://shopify/Customer/<id>` from a payload, or null. Compliance topics
 * carry `customer.id`; `customers/delete` is the customer resource itself,
 * so its `id` is read only when `topLevel` is set.
 */
export function payloadCustomerGid(payload: unknown, topLevel = false): string | null {
  const p = payload as {id?: unknown; customer?: {id?: unknown}} | null;
  const id = topLevel ? p?.id : p?.customer?.id;
  const text = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : typeof id === 'string' ? id.trim() : '';
  return /^[1-9][0-9]{0,19}$/.test(text) ? `gid://shopify/Customer/${text}` : null;
}

type NewRequest = {id: string; kind: RequestKind; source: string; gid: string | null; status: 'pending' | 'done'; attempts: number};

async function recordRequest(db: D1Database, r: NewRequest, now: number): Promise<void> {
  await db
    .prepare(
      'INSERT INTO rights_requests (id, kind, source, shopify_gid, status, received_at, attempts, last_attempt_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
    )
    .bind(r.id, r.kind, r.source, r.gid, r.status, now, r.attempts, r.attempts ? now : null, r.status === 'done' ? now : null)
    .run();
}

/** Shopify's delivery id makes a redelivery land on the same row. */
function requestId(request: Request): string {
  const hook = request.headers.get('X-Shopify-Webhook-Id')?.trim() ?? '';
  return /^[A-Za-z0-9-]{1,64}$/.test(hook) ? `wh_${hook}` : `rr_${randomToken(12)}`;
}

/**
 * One Shopify compliance webhook. Order: method, secret, signature, topic,
 * payload; nothing is read or written before the signature matches the raw
 * body (same pattern as api.shopify.orders-paid).
 */
export async function handleComplianceWebhook(
  topic: ComplianceTopic,
  request: Request,
  env: ComplianceEnv,
  opts: {fetcher?: typeof fetch; post?: AlertPoster; now?: number} = {},
): Promise<Response> {
  const now = opts.now ?? Date.now();
  const secret = env.SHOPIFY_WEBHOOK_SECRET?.trim();
  if (!secret) return notFound();
  if (request.method !== 'POST') return new Response('Method not allowed', {status: 405, headers: accountHeaders({Allow: 'POST'})});
  const body = await request.text();
  if (!(await verifyShopifyHmac(secret, body, request.headers.get('X-Shopify-Hmac-Sha256')))) {
    return new Response('Bad signature', {status: 401, headers: accountHeaders()});
  }
  const headerTopic = request.headers.get('X-Shopify-Topic');
  if (headerTopic && headerTopic !== topic) return new Response('Wrong topic', {status: 400, headers: accountHeaders()});
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Bad payload', {status: 400, headers: accountHeaders()});
  }
  const db = env.SUPPORT_DB;
  // 503 makes Shopify redeliver once the database is back.
  if (!db) return new Response('Not available', {status: 503, headers: accountHeaders()});
  const id = requestId(request);

  if (topic === 'shop/redact') {
    await recordRequest(db, {id, kind: 'shop_redact', source: topic, gid: null, status: 'done', attempts: 0}, now);
    console.log('[accounts] shop/redact recorded', id);
    return jsonResponse({received: true});
  }

  const gid = payloadCustomerGid(payload, topic === 'customers/delete');
  if (!gid) return new Response('No customer', {status: 400, headers: accountHeaders()});

  if (topic === 'customers/data_request') {
    await recordRequest(db, {id, kind: 'export', source: topic, gid, status: 'pending', attempts: 0}, now);
    console.log('[accounts] customers/data_request recorded', id);
    return jsonResponse({received: true});
  }

  const result = await redactCustomer(env, gid, opts.fetcher);
  const erased = !result.chatfpv || result.chatfpv.ok;
  await recordRequest(db, {id, kind: 'erase', source: topic, gid, status: erased ? 'done' : 'pending', attempts: 1}, now);
  console.log(`[accounts] ${topic}`, {id, accounts: result.accounts, chatfpv: result.chatfpv?.status ?? 'not called'});
  if (!erased) {
    await opsAlertOnce(env, 'rights-pending', `A ChatFPV erase failed (request ${id}); the scheduled job retries it. ${CLI_HINT}`, now, opts.post);
  }
  return jsonResponse({received: true});
}

type QueueRow = {id: string; kind: RequestKind; shopify_gid: string | null; attempts: number; received_at: number};

export type QueueReport = {done: string[]; ready: string[]; failed: string[]};

/**
 * Scheduled: work up to BATCH pending rows (erase: local rows plus ChatFPV;
 * export: build the JSON into `export_json`), then alert once per UTC day
 * while anything waits on a person, and purge old records.
 */
export async function runRightsQueue(env: ComplianceEnv, opts: {fetcher?: typeof fetch; post?: AlertPoster; now?: number} = {}): Promise<QueueReport> {
  const now = opts.now ?? Date.now();
  const report: QueueReport = {done: [], ready: [], failed: []};
  const db = env.SUPPORT_DB;
  if (!db) return report;
  const rows =
    (
      await db
        .prepare("SELECT id, kind, shopify_gid, attempts, received_at FROM rights_requests WHERE status = 'pending' ORDER BY received_at LIMIT ?")
        .bind(BATCH)
        .all<QueueRow>()
    ).results ?? [];
  for (const row of rows) {
    const gid = row.shopify_gid;
    if (!gid) {
      await db.prepare("UPDATE rights_requests SET status = 'done', completed_at = ? WHERE id = ?").bind(now, row.id).run();
      report.done.push(row.id);
      continue;
    }
    if (row.kind === 'erase') {
      const result = await redactCustomer(env, gid, opts.fetcher, true);
      if (!result.chatfpv || result.chatfpv.ok) {
        await db
          .prepare("UPDATE rights_requests SET status = 'done', attempts = attempts + 1, last_attempt_at = ?, completed_at = ? WHERE id = ?")
          .bind(now, now, row.id)
          .run();
        report.done.push(row.id);
        continue;
      }
    } else if (row.kind === 'export') {
      const result = await exportCustomer(env, gid, opts.fetcher);
      if (result.complete) {
        const file = {request: row.id, shopify_customer: gid, generated_at: new Date(now).toISOString(), ...result.data};
        await db
          .prepare("UPDATE rights_requests SET status = 'ready', attempts = attempts + 1, last_attempt_at = ?, export_json = ? WHERE id = ?")
          .bind(now, JSON.stringify(file), row.id)
          .run();
        report.ready.push(row.id);
        continue;
      }
    }
    await db.prepare('UPDATE rights_requests SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?').bind(now, row.id).run();
    report.failed.push(row.id);
  }

  const waiting = await db
    .prepare("SELECT status, COUNT(*) AS n, MIN(received_at) AS oldest FROM rights_requests WHERE status IN ('pending', 'ready') GROUP BY status")
    .all<{status: string; n: number; oldest: number}>();
  for (const w of waiting.results ?? []) {
    if (w.status === 'pending' && !report.failed.length) continue;
    const what = w.status === 'ready' ? 'export(s) ready to send to the customer' : 'data subject request(s) still failing';
    await opsAlertOnce(env, `rights-${w.status}`, `${w.n} ${what}; oldest received ${utcDay(w.oldest)}. ${CLI_HINT}`, now, opts.post);
  }

  await db.prepare("DELETE FROM rights_requests WHERE status = 'done' AND completed_at < ?").bind(now - DONE_RETENTION_MS).run();
  await purgeOpsAlerts(db, now);
  return report;
}
