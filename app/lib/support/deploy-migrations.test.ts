import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {it} from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));

it('applies pending migrations before deployment and refuses an unverifiable production schema', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'support-migrations-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  writeFileSync(join(dir, 'npx'), `#!/bin/sh
case "$*" in
  *"migrations list"*)
    if [ "$TEST_DENIED" = "1" ]; then echo "authentication error 10000"; exit 1; fi
    echo "0012_support_reply_idempotency.sql"
    ;;
  *"migrations apply"*) echo "TEST_MIGRATIONS_APPLIED"; exit "\${TEST_APPLY_EXIT:-0}" ;;
  *) exit 2 ;;
esac
`, {mode: 0o755});
  writeFileSync(join(dir, 'curl'), '#!/bin/sh\nprintf \'%s\' "$TEST_SCHEMA"\n', {mode: 0o755});
  const run = (mode: string, fixture: Record<string, string> = {}) => spawnSync('bash', ['scripts/d1-migrations.sh', mode], {
    cwd: root,
    encoding: 'utf8',
    env: {PATH: `${dir}:${process.env.PATH}`, HOME: dir, ...fixture},
  });
  const applied = run('apply');
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /TEST_MIGRATIONS_APPLIED/);
  assert.equal(run('apply', {TEST_APPLY_EXIT: '1'}).status, 1);
  const denied = {TEST_DENIED: '1'};
  assert.equal(run('apply', denied).status, 1);
  assert.equal(run('check', denied).status, 0);
  assert.equal(run('apply', {...denied, TEST_SCHEMA: JSON.stringify({migrations: ['0001_support_tickets.sql']})}).status, 1);
  const all = readdirSync(join(root, 'migrations')).filter((name) => name.endsWith('.sql'));
  assert.equal(run('apply', {...denied, TEST_SCHEMA: JSON.stringify({migrations: all})}).status, 0);
  const workflow = readFileSync(join(root, '.github/workflows/cloudflare-production.yml'), 'utf8');
  const migrate = workflow.indexOf('run: scripts/d1-migrations.sh apply');
  const deploy = workflow.indexOf('command: deploy --config wrangler.production.toml');
  assert.ok(migrate >= 0 && deploy > migrate);
});
