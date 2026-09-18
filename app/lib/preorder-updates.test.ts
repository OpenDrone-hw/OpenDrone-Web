import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseUpdates} from './preorder-updates.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/preorder-updates.test.ts

const read = (p: string) =>
  readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('parseUpdates', () => {
  it('reads the dated entries', () => {
    const updates = parseUpdates([
      {date: '2026-09-18', title: 'One', body: 'First.'},
      {date: '2026-10-02', title: 'Two', body: 'Second.'},
    ]);
    assert.deepEqual(
      updates.map((u) => u.title),
      ['Two', 'One'],
    );
  });

  it('sorts newest first whatever the file order is', () => {
    // The file is edited by hand, so its order is never trusted.
    const dates = parseUpdates([
      {date: '2026-09-18', title: 'a', body: 'a'},
      {date: '2027-01-04', title: 'b', body: 'b'},
      {date: '2026-12-31', title: 'c', body: 'c'},
    ]).map((u) => u.date);
    assert.deepEqual(dates, ['2027-01-04', '2026-12-31', '2026-09-18']);
  });

  it('drops an entry it cannot date or read', () => {
    const updates = parseUpdates([
      {date: '2026-09-18', title: 'Kept', body: 'Kept.'},
      {date: 'soon', title: 'No date', body: 'x'},
      {date: '2026-09-19', title: '  ', body: 'x'},
      {date: '2026-09-20', title: 'No body', body: '   '},
      {date: '2026-09-21', title: 'Wrong type', body: 42},
      null,
      'nope',
      [],
    ]);
    assert.deepEqual(
      updates.map((u) => u.title),
      ['Kept'],
    );
  });

  it('never throws', () => {
    assert.deepEqual(parseUpdates(null), []);
    assert.deepEqual(parseUpdates(undefined), []);
    assert.deepEqual(parseUpdates({}), []);
    assert.deepEqual(parseUpdates('<html>down</html>'), []);
  });
});

describe('the update file on disk', () => {
  const src = read('content/copy/preorder-updates.json');
  const updates = parseUpdates(JSON.parse(src));

  it('parses, and every entry in it survives parsing', () => {
    assert.equal(updates.length, (JSON.parse(src) as unknown[]).length);
    assert.ok(updates.length >= 1, 'the file has no updates');
  });

  it('is written in the house style', () => {
    assert.ok(!/[—–]/.test(src), 'an update contains a dash character');
  });
});
