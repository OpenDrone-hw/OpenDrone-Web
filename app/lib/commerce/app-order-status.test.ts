import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {safeTrackingUrl, statusProof} from './app-order-status.ts';

const params = (q: string) => new URLSearchParams(q);
const KEY = 'a'.repeat(32);

describe('order status proof', () => {
  it('uses the mail key from any device, with or without a cookie', () => {
    assert.deepEqual(statusProof(params(`order=W1042&key=${KEY}`), null), {
      number: 'W1042',
      key: KEY,
    });
    assert.deepEqual(
      statusProof(params(`order=W1042&key=${KEY}`), {
        number: 'W9',
        token: 't'.repeat(32),
      }),
      {number: 'W1042', key: KEY},
    );
  });

  it('refuses a key without a proper order number or in the wrong shape, and never falls back to another order', () => {
    assert.equal(
      statusProof(params(`key=${KEY}`), {number: 'W9', token: 't'.repeat(32)}),
      null,
    );
    assert.equal(statusProof(params('order=W1&key=short'), null), null);
    assert.equal(
      statusProof(params(`order=${'1'.repeat(30)}&key=${KEY}`), null),
      null,
    );
  });

  it('keeps the cookie path for the device that ordered', () => {
    const saved = {number: 'W9', token: 't'.repeat(32)};
    assert.deepEqual(statusProof(params(''), saved), saved);
    assert.deepEqual(statusProof(params('order=W9'), saved), saved);
    assert.equal(statusProof(params('order=W10'), saved), null);
    assert.equal(statusProof(params(''), null), null);
  });

  it('links tracking only over http(s)', () => {
    assert.equal(
      safeTrackingUrl('https://track.example/CD1'),
      'https://track.example/CD1',
    );
    assert.equal(safeTrackingUrl('javascript:alert(1)'), null);
    assert.equal(safeTrackingUrl(null), null);
  });
});
