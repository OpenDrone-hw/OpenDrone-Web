import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {PRODUCT_SAFETY, safetyFamily, safetyWarnings, safetyWarningsApproved} from './product-safety.ts';

const approved = {
  approved: true,
  documentId: 'DOC-SAFETY-OPENDRONE',
  documentVersion: 1,
  families: {esc: {en: ['Line one.', 'Line two.'], nl: ['Regel een.']}},
};

describe('product safety warnings', () => {
  it('renders nothing from the committed file until it is approved', () => {
    if (!safetyWarningsApproved(PRODUCT_SAFETY)) {
      for (const family of ['fc', 'esc', 'rx', 'frame', 'motor'] as const) {
        assert.deepEqual(safetyWarnings(family, 'en'), [], family);
      }
    }
  });

  it('needs both the approved flag and a leaflet version', () => {
    assert.equal(safetyWarningsApproved(approved), true);
    assert.equal(safetyWarningsApproved({...approved, approved: false}), false);
    assert.equal(safetyWarningsApproved({...approved, documentVersion: null}), false);
    assert.equal(safetyWarningsApproved({...approved, documentVersion: ' '}), false);
    assert.deepEqual(safetyWarnings('esc', 'en', {...approved, approved: false}), []);
  });

  it('returns the approved lines per family and language', () => {
    assert.deepEqual(safetyWarnings('esc', 'en', approved), ['Line one.', 'Line two.']);
    assert.deepEqual(safetyWarnings('esc', 'nl', approved), ['Regel een.']);
    assert.deepEqual(safetyWarnings('esc', 'fr', approved), []);
    assert.deepEqual(safetyWarnings('fc', 'en', approved), []);
    assert.deepEqual(safetyWarnings(null, 'en', approved), []);
  });

  it('maps product handles to leaflet families', () => {
    assert.equal(safetyFamily('openfc-lite'), 'fc');
    assert.equal(safetyFamily('openesc'), 'esc');
    assert.equal(safetyFamily('openrx'), 'rx');
    assert.equal(safetyFamily('openframe'), 'frame');
    assert.equal(safetyFamily('openframe-spares'), 'frame');
    assert.equal(safetyFamily('openmotor'), 'motor');
    assert.equal(safetyFamily('props'), null);
  });
});
