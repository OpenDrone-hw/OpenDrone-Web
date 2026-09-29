import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {usCartNotice} from './us-cart-notice.ts';

const march = 'ships by 31 March 2027 if the target is reached';

describe('usCartNotice', () => {
  it('names the batch when every line ships from the same one', () => {
    const notice = usCartNotice([
      {sku: 'OPENFC-LITE-20', shipPromise: march},
      {sku: 'OPENFRAME-5', shipPromise: march},
    ]);
    assert.deepEqual(notice, {kind: 'batch', batch: 'March 2027'});
  });

  it('uses the general form for an FCC-gated line', () => {
    assert.deepEqual(usCartNotice([{sku: 'OPENRX-LITE', shipPromise: march}, {sku: 'OPENFC-LITE-20', shipPromise: march}]), {kind: 'general'});
  });

  it('uses the general form for a line without a batch month or a mix', () => {
    assert.deepEqual(usCartNotice([{sku: 'X', shipPromise: null}]), {kind: 'general'});
    assert.deepEqual(
      usCartNotice([{sku: 'A', shipPromise: march}, {sku: 'B', shipPromise: 'ships early November 2026'}]),
      {kind: 'general'},
    );
  });
});
