import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {liveLedgerEvents} from './timeline-live.ts';

describe('timeline ledger events of repos that are no longer public', () => {
  const events = [
    {id: 'repo:OpenFC-Lite', repo: 'OpenFC-Lite'},
    {id: 'repo:Gone', repo: 'Gone'},
    {id: 'release:Gone:v1', repo: 'Gone'},
    {id: 'repo:Unlisted', repo: 'Unlisted'},
  ];
  it('drops every event of a repo marked gone, keeps the rest', () => {
    const live = liveLedgerEvents({events, repos: {'OpenFC-Lite': {}, Gone: {gone: '2026-11-11'}}});
    assert.deepEqual(live.map((e) => e.id), ['repo:OpenFC-Lite', 'repo:Unlisted']);
  });
  it('keeps everything for a ledger without a repos map, and nothing without a ledger', () => {
    assert.equal(liveLedgerEvents({events}).length, 4);
    assert.deepEqual(liveLedgerEvents(null), []);
  });
  it('the route reads the ledger through it and the sync marks gone repos', () => {
    assert.match(readFileSync(new URL('../routes/timeline.tsx', import.meta.url), 'utf8'), /ledgerEvents: liveLedgerEvents\(ledger\)/);
    const sync = readFileSync(new URL('../../scripts/sync-timeline.mjs', import.meta.url), 'utf8');
    assert.match(sync, /entry\.gone = TODAY/);
    assert.match(sync, /if \(repos\.length\)/);
  });
});
