import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {addressForCountry, defaultAddress, prefillCountry} from './address-fields.ts';
import {dialCode, formatPhone, phoneForCountry, phonePrefix, phoneProblem} from './phone.ts';

describe('dial code', () => {
  it('follows the delivery country', () => {
    assert.equal(phonePrefix('BE'), '+32 ');
    assert.equal(phonePrefix('nl'), '+31 ');
    assert.equal(dialCode('LU'), '352');
    assert.equal(phonePrefix('ZZ'), '');
  });
  it('keeps a typed +code when the country changes, else swaps the prefix', () => {
    assert.equal(phoneForCountry('+32 ', 'BE', 'NL'), '+31 ');
    assert.equal(phoneForCountry('', 'BE', 'DE'), '+49 ');
    assert.equal(phoneForCountry('+32 470 12 34 56', 'BE', 'NL'), '+31 47 012 3456');
    assert.equal(phoneForCountry('+44 7400 123456', 'BE', 'NL'), '+44 7400 123456');
  });
});

describe('formatting as typed', () => {
  it('groups Belgian mobiles and landlines', () => {
    assert.equal(formatPhone('0470123456', 'BE').display, '+32 470 12 34 56');
    assert.equal(formatPhone('+32 470 12', 'BE').display, '+32 470 12');
    assert.equal(formatPhone('+32 470 12 34 56', 'BE').e164, '+32470123456');
  });
  it('drops the trunk 0 after the code, writes 00 as +, groups NL, FR, DE', () => {
    assert.equal(formatPhone('+32 0470123456', 'BE').e164, '+32470123456');
    assert.equal(formatPhone('0032470123456', 'NL').e164, '+32470123456');
    assert.equal(formatPhone('0612345678', 'NL').display, '+31 6 12 34 56 78');
    assert.equal(formatPhone('0612345678', 'FR').display, '+33 6 12 34 56 78');
    assert.equal(formatPhone('01511234567', 'DE').display, '+49 151 1234 567');
  });
  it('keeps the 0 of an Italian number and an empty field empty', () => {
    assert.equal(formatPhone('0612345678', 'IT').e164, '+390612345678');
    assert.equal(formatPhone('', 'BE').display, '');
    assert.equal(formatPhone('+32 ', 'BE').e164, '');
  });
  it('only ever yields what storefront.checkout accepts', () => {
    for (const [raw, c] of [['0470123456', 'BE'], ['+44 7400 123456', 'NL'], ['0031612345678', 'DE']] as const) {
      assert.match(formatPhone(raw, c).e164, /^\+?[0-9][0-9 ()./-]{5,22}$/);
    }
  });
});

describe('validation per country', () => {
  it('accepts a good number and an empty one', () => {
    assert.equal(phoneProblem('+32 470 12 34 56', 'BE'), null);
    assert.equal(phoneProblem('+32 ', 'BE'), null);
    assert.equal(phoneProblem('', 'BE'), null);
    assert.equal(phoneProblem('0612345678', 'NL'), null);
  });
  it('says plainly what is wrong', () => {
    assert.match(phoneProblem('+32 470 12', 'BE', 'Belgium') ?? '', /too short.*Belgium.*\+32 470 12 34 56/);
    assert.match(phoneProblem('+31 6 12 34', 'NL', 'Netherlands') ?? '', /too short.*Netherlands/);
    assert.match(phoneProblem('+32 470 12 34 56 7', 'BE') ?? '', /too long/);
    assert.match(phoneProblem('+32 470 12 34 5', 'BE') ?? '', /9 digits/);
    assert.match(phoneProblem('+33 0 12', 'FR') ?? '', /too short/);
  });
  it('checks another country by its own code', () => {
    assert.equal(phoneProblem('+44 7400 123456', 'BE'), null);
    assert.match(phoneProblem('+44 74', 'BE') ?? '', /too short/);
  });
});

describe('prefill precedence', () => {
  const ship = ['BE', 'NL', 'DE'];
  it('country: explicit pick, then saved address, then request country', () => {
    assert.equal(prefillCountry({query: 'DE', saved: 'NL', geo: 'BE', ship}), 'DE');
    assert.equal(prefillCountry({saved: 'nl', geo: 'BE', ship}), 'NL');
    assert.equal(prefillCountry({saved: 'US', geo: 'DE', ship}), 'DE');
    assert.equal(prefillCountry({saved: 'US', geo: 'FR', ship}), null);
  });
  it('the newest saved address wins, else the newest order address; none for a guest', () => {
    const a = [{id: 'o1', saved: false}, {id: 's1', saved: true}, {id: 's2', saved: true}];
    assert.equal(defaultAddress(a)?.id, 's2');
    assert.equal(defaultAddress([{id: 'o1', saved: false}, {id: 'o2', saved: false}])?.id, 'o1');
    assert.equal(defaultAddress([]), null);
    assert.equal(defaultAddress(null), null);
  });
  it('an address fills the form only in its own country', () => {
    assert.equal(addressForCountry({country: 'NL'}, 'nl')?.country, 'NL');
    assert.equal(addressForCountry({country: 'NL'}, 'BE'), null);
  });
});
