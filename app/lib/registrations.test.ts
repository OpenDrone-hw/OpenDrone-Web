import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {EU_COUNTRIES} from './shipping-rates.ts';
import {registrationRows, type RegistrationsFile} from './registrations.ts';

const FILE = JSON.parse(
  fs.readFileSync(new URL('../../content/registrations.json', import.meta.url), 'utf8'),
) as RegistrationsFile;

describe('content/registrations.json', () => {
  it('has exactly the 27 EU member states', () => {
    const codes = Object.keys(FILE).filter((k) => !k.startsWith('$')).sort();
    assert.deepEqual(codes, [...EU_COUNTRIES].sort());
    assert.equal(codes.length, 27);
  });

  it('has weee and packaging everywhere and idu only in France', () => {
    for (const [code, entry] of Object.entries(FILE)) {
      if (code.startsWith('$')) continue;
      assert.equal(typeof entry, 'object', code);
      const keys = Object.keys(entry).sort();
      assert.deepEqual(keys, code === 'FR' ? ['idu', 'packaging', 'weee'] : ['packaging', 'weee'], code);
      for (const value of Object.values(entry)) {
        assert.ok(value === null || (typeof value === 'string' && value.trim() !== ''), code);
      }
    }
  });
});

describe('registrationRows', () => {
  it('lists only the numbers that are set, by country name', () => {
    const rows = registrationRows({
      $comment: 'x',
      FR: {weee: 'FR123', packaging: null, idu: 'FR-IDU-1'},
      DE: {weee: 'DE 12345678', packaging: '  '},
      BE: {weee: null, packaging: null},
    });
    assert.deepEqual(rows, [
      {country: 'FR', name: 'France', numbers: [{kind: 'weee', value: 'FR123'}, {kind: 'idu', value: 'FR-IDU-1'}]},
      {country: 'DE', name: 'Germany', numbers: [{kind: 'weee', value: 'DE 12345678'}]},
    ]);
    assert.equal(registrationRows({DE: {weee: 'x'}}, 'nl')[0].name, 'Duitsland');
  });

  it('shows nothing while every number is null', () => {
    assert.deepEqual(registrationRows(FILE), []);
  });
});
