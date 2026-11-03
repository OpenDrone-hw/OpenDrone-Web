import assert from 'node:assert/strict';
import {test} from 'node:test';
import {COUNTRY_NAMES_EN} from './country-names.ts';
import {SHIP_COUNTRY_CODES, countryName, shipCountryOptions} from './shipping-rates.ts';

// React #418 on /cart: the Ship to picker's option text came from
// Intl.DisplayNames, whose names differ between the Worker and the browser.

test('every destination code has a fixed English name', () => {
  for (const code of SHIP_COUNTRY_CODES) assert.ok(COUNTRY_NAMES_EN[code], code);
});

test('countryName reads the table, not Intl, for English', () => {
  const real = Intl.DisplayNames;
  // A browser with other CLDR names must not change the rendered text.
  (Intl as {DisplayNames: unknown}).DisplayNames = class {
    of() {
      return 'WRONG';
    }
  };
  try {
    assert.equal(countryName('CV'), COUNTRY_NAMES_EN.CV);
    assert.equal(countryName('BE'), 'Belgium');
  } finally {
    (Intl as {DisplayNames: unknown}).DisplayNames = real;
  }
});

test('the picker order does not depend on localeCompare', () => {
  const orig = String.prototype.localeCompare;
  String.prototype.localeCompare = () => 0;
  try {
    const names = shipCountryOptions('en-test-order').map((o) => o.name);
    const key = (n: string) => n.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let i = 1; i < names.length; i++) assert.ok(key(names[i - 1]) <= key(names[i]), `${names[i - 1]} before ${names[i]}`);
  } finally {
    String.prototype.localeCompare = orig;
  }
});
