import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {customerGid, parseArgs, sqlFor} from '../../../scripts/accounts/rights.mjs';
import {testD1} from '../support/testing.ts';
import {runRightsQueue} from './compliance.ts';
import {upsertAccount} from './sessions.ts';

describe('scripts/accounts/rights.mjs', () => {
  it('takes a numeric customer id or its GID, nothing else', () => {
    assert.equal(customerGid('207119551'), 'gid://shopify/Customer/207119551');
    assert.equal(customerGid('gid://shopify/Customer/207119551'), 'gid://shopify/Customer/207119551');
    assert.equal(customerGid("1'; DROP TABLE od_accounts; --"), null);
    assert.equal(customerGid('someone@example.com'), null);
    assert.throws(() => parseArgs(['erase', 'x@example.com']), /customer id/);
    assert.throws(() => parseArgs(['fetch', "wh_1' OR 1=1"]), /request id/);
    assert.throws(() => parseArgs(['drop']), /command/);
    assert.deepEqual(parseArgs(['erase', '42', '--apply']), {command: 'erase', target: 'gid://shopify/Customer/42', apply: true, staging: false, out: null});
  });

  it('queues an erase that the Worker queue then works, ChatFPV included', async () => {
    const db = await testD1();
    assert.ok(db, 'node:sqlite required');
    await upsertAccount(db, 'gid://shopify/Customer/42');
    await db.prepare(sqlFor(parseArgs(['erase', '42']), Date.now(), 'cli_test')).run();
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ok: true});
    }) as typeof fetch;
    const env = {ACCOUNT_PAIRWISE_SALT: 'salt', CHATFPV_URL: 'https://chatfpv.example', CHATFPV_KEY: 'k', SUPPORT_DB: db};
    const report = await runRightsQueue(env, {fetcher});
    assert.deepEqual(report.done, ['cli_test']);
    assert.deepEqual(calls, ['https://chatfpv.example/v1/account/erase']);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM od_accounts').first<{n: number}>())!.n, 0);
    const rows = (await db.prepare(sqlFor(parseArgs(['status']))).all<{id: string; status: string}>()).results;
    assert.deepEqual(rows.map((r) => [r.id, r.status]), [['cli_test', 'done']]);
  });

  it('close clears a stored export', async () => {
    const db = await testD1();
    assert.ok(db);
    await db
      .prepare("INSERT INTO rights_requests (id, kind, source, status, received_at, export_json) VALUES ('wh_1', 'export', 'customers/data_request', 'ready', 1, '{}')")
      .run();
    await db.prepare(sqlFor(parseArgs(['close', 'wh_1']))).run();
    const row = await db.prepare("SELECT status, export_json FROM rights_requests WHERE id = 'wh_1'").first<{status: string; export_json: string | null}>();
    assert.deepEqual({...row}, {status: 'done', export_json: null});
  });
});
