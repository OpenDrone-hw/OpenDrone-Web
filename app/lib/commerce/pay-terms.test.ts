import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {payTermLinks} from './pay-terms.ts';

test('the pay step always links terms, withdrawal and privacy', () => {
  assert.deepEqual(payTermLinks(false).map((l) => l.to), ['/algemene-voorwaarden', '/herroepingsrecht#withdraw', '/privacy']);
});

test('a cart with a preorder also links the preorder article', () => {
  const links = payTermLinks(true);
  assert.equal(links.length, 4);
  assert.equal(links[3].to, '/algemene-voorwaarden#art-7bis');
});

test('every label is an existing chrome copy string', () => {
  const chrome = JSON.parse(readFileSync(new URL('../../../content/copy/chrome.json', import.meta.url), 'utf8')) as Record<string, string>;
  for (const l of payTermLinks(true)) assert.ok(chrome[l.copy.replace('chrome.', '')], l.copy);
});
