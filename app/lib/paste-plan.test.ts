import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as lib from '../../scripts/shopify-templates/paste-lib.mjs';

// Pure parts of `npm run emails:paste`. The browser part is not tested here.

const mappings = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dirname, '../../scripts/shopify-templates/mappings.json'),
    'utf8',
  ),
);
const tpl = {key: 'k', adminPath: 'order_confirmation', emailSubject: 'Order {{ name }} confirmed', phase: 1};

describe('paste plan', () => {
  it('hashes utf8 text with sha256', () => {
    assert.equal(lib.sha256('abc'), createHash('sha256').update('abc').digest('hex'));
  });

  it('builds the admin edit url', () => {
    assert.equal(
      lib.editUrl('shop', 'order_confirmation'),
      'https://admin.shopify.com/store/shop/email_templates/order_confirmation/edit',
    );
  });

  it('selects phase 1 templates and filters by key', () => {
    const all = lib.selectTemplates(mappings, null);
    assert.ok(all.length > 0 && all.every((t: {phase: number}) => t.phase === 1));
    const one = lib.selectTemplates(mappings, [all[0].key]);
    assert.equal(one.length, 1);
    assert.throws(() => lib.selectTemplates(mappings, ['nope']), /unknown template key/);
  });

  it('parses flags and refuses unknown ones', () => {
    assert.deepEqual(lib.parseArgs(['--apply', '--only', 'a,b', '--continue']), {
      apply: true,
      continueOnError: true,
      only: ['a', 'b'],
    });
    assert.equal(lib.parseArgs([]).apply, false);
    assert.throws(() => lib.parseArgs(['--force']), /unknown argument/);
  });

  it('plans the action from body and subject', () => {
    const live = {body: '<p>x</p>', subject: tpl.emailSubject};
    assert.equal(lib.planRow(tpl, '<p>x</p>', live).action, 'ok');
    assert.equal(lib.planRow(tpl, '<p>x</p>', {...live, subject: 'Order {{name}} confirmed'}).action, 'ok');
    assert.equal(lib.planRow(tpl, '<p>y</p>', live).action, 'set body');
    assert.equal(lib.planRow(tpl, '<p>x</p>', {...live, subject: 'Old'}).action, 'set subject');
    assert.equal(lib.planRow(tpl, '<p>y</p>', {...live, subject: null}).action, 'set body+subject');
  });

  it('prints an aligned table with errors', () => {
    const ok = lib.planRow(tpl, 'a', {body: 'a', subject: tpl.emailSubject});
    const out = lib.formatTable([ok, {key: 'bad', liveHash: null, repoHash: lib.sha256('a'), error: 'boom'}]);
    const lines = out.split('\n');
    assert.match(lines[0], /^template\s+live\s+repo\s+subject\s+action$/);
    assert.match(lines[2], /ok$/);
    assert.match(lines[3], /ERROR: boom$/);
  });
});
