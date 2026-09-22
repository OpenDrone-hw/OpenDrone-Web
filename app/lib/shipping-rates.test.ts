import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {BLOCKED_COUNTRIES, SHIPPING_ZONES, countryName, shippingQuote} from './shipping-rates.ts';

describe('shippingQuote', () => {
  it('uses the flat bpost rate table', () => {
    const rate = (c: string) => {
      const q = shippingQuote(c);
      return q && !q.blocked ? q.rate : null;
    };
    assert.equal(rate('BE'), 8.5);
    for (const c of ['DE', 'FR', 'LU', 'NL']) assert.equal(rate(c), 9.95);
    for (const c of ['AT', 'ES', 'IT', 'PL', 'SE', 'BG']) assert.equal(rate(c), 12.95);
    for (const c of ['CY', 'EE', 'MT']) assert.equal(rate(c), 16.95);
    for (const c of ['GB', 'CH', 'NO', 'IS', 'LI']) assert.equal(rate(c), 24.95);
    assert.equal(rate('US'), 19.95);
    for (const c of ['CA', 'AU', 'JP']) assert.equal(rate(c), 39.95);
  });

  it('does not ship to the blocked countries', () => {
    for (const c of ['RU', 'BY', 'IR', 'KP', 'SY', 'CU']) {
      assert.deepEqual(shippingQuote(c), {country: c, blocked: true});
    }
    assert.equal(BLOCKED_COUNTRIES.size, 6);
  });

  it('never collects duties at checkout: none in the EU, the carrier elsewhere', () => {
    const duty = (c: string) => {
      const q = shippingQuote(c);
      return q && !q.blocked ? q.duty : null;
    };
    assert.equal(duty('BE'), 'none');
    assert.equal(duty('BG'), 'none');
    assert.equal(duty('US'), 'us');
    assert.equal(duty('GB'), 'intl');
    assert.equal(duty('CA'), 'intl');
  });

  it('ignores an unknown or malformed country and lists each country once', () => {
    assert.equal(shippingQuote(null), null);
    assert.equal(shippingQuote('Belgium'), null);
    assert.equal(shippingQuote('be')?.country, 'BE');
    const all = SHIPPING_ZONES.flatMap((z) => z.countries);
    assert.equal(new Set(all).size, all.length);
    assert.equal(all.length, 27 + 5 + 1);
  });

  it('names a country in English', () => {
    assert.equal(countryName('BE'), 'Belgium');
    assert.equal(countryName('GB'), 'United Kingdom');
  });
});
