import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {EU_COUNTRIES} from './shipping-rates.ts';
import {
  REGISTRATIONS,
  euSaleOpen,
  registrationNumbers,
  registrationRows,
  type CountryRegistrations,
  type RegistrationsFile,
} from './registrations.ts';

const FILE = JSON.parse(
  fs.readFileSync(new URL('../../content/registrations.json', import.meta.url), 'utf8'),
) as RegistrationsFile;

describe('content/registrations.json', () => {
  it('has exactly the 27 EU member states', () => {
    const codes = Object.keys(FILE).filter((k) => !k.startsWith('$')).sort();
    assert.deepEqual(codes, [...EU_COUNTRIES].sort());
    assert.equal(codes.length, 27);
  });

  it('has weee and packaging everywhere, idu only in France, the offer flag and sale approval', () => {
    for (const [code, entry] of Object.entries(FILE)) {
      if (code.startsWith('$')) continue;
      assert.equal(typeof entry, 'object', code);
      const {offerNeedsNumber, saleApproved, ...numbers} = entry as CountryRegistrations;
      assert.equal(saleApproved, true, code);
      assert.equal(offerNeedsNumber, ['DE', 'FR', 'ES', 'IE'].includes(code), code);
      assert.deepEqual(Object.keys(numbers).sort(), code === 'FR' ? ['idu', 'packaging', 'weee'] : ['packaging', 'weee'], code);
      for (const value of Object.values(numbers)) {
        assert.ok(value === null || (typeof value === 'string' && value.trim() !== ''), code);
      }
    }
  });

  it('is the file the gate reads', () => {
    assert.deepEqual(REGISTRATIONS, FILE);
  });
});

describe('euSaleOpen', () => {
  const file = (de: string | null, idu: string | null = null): RegistrationsFile => ({
    DE: {weee: de, packaging: null, saleApproved: true, offerNeedsNumber: true},
    FR: {weee: 'FR-WEEE', packaging: null, idu, saleApproved: true, offerNeedsNumber: true},
    NL: {weee: null, packaging: null, saleApproved: true, offerNeedsNumber: false},
  });

  it('keeps Germany closed with a null WEEE number and opens it once set', () => {
    assert.equal(euSaleOpen('DE', file(null)), false);
    assert.equal(euSaleOpen('DE', file('  ')), false);
    assert.equal(euSaleOpen('DE', file('DE12345678')), true);
  });

  it('opens France on its IDU, not its WEEE number', () => {
    assert.equal(euSaleOpen('FR', file(null)), false);
    assert.equal(euSaleOpen('FR', file(null, 'FR123456_01ABCD')), true);
  });

  it('opens an approved country with no offer-number requirement, and closes an unknown one', () => {
    assert.equal(euSaleOpen('NL', file(null)), true);
    assert.equal(euSaleOpen('BE', file(null)), false);
  });

  it('never opens on numbers alone or a false approval, nor without a required offer number', () => {
    for (const saleApproved of [undefined, false]) {
      assert.equal(euSaleOpen('DE', {DE: {saleApproved, weee: 'DE123', offerNeedsNumber: true}}), false);
      assert.equal(euSaleOpen('NL', {NL: {saleApproved, offerNeedsNumber: false}}), false);
    }
    // The committed file approves every country; DE, FR, ES and IE stay closed until their offer numbers are set.
    for (const country of EU_COUNTRIES) assert.equal(euSaleOpen(country), !['DE', 'FR', 'ES', 'IE'].includes(country), country);
  });

  it('lists the numbers set for one country', () => {
    assert.deepEqual(registrationNumbers('DE', file('DE12345678')), [{kind: 'weee', value: 'DE12345678'}]);
    assert.deepEqual(registrationNumbers('NL', file(null)), []);
    assert.deepEqual(registrationNumbers(null, file(null)), []);
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
