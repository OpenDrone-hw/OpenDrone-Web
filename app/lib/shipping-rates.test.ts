import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  BLOCKED_COUNTRIES,
  SHIPPING_ZONES,
  LIKELY_SHIP_COUNTRIES,
  SHIP_COUNTRY_CODES,
  UNINHABITED_TERRITORIES,
  countryFromAcceptLanguage,
  countryName,
  shipCountryCookie,
  shipCountryForRequest,
  shipCountryFromCookie,
  shipCountryOptions,
  shipCountryPicker,
  shippingQuote,
} from './shipping-rates.ts';

describe('shippingQuote', () => {
  it('uses the flat bpost rate table', () => {
    const rate = (c: string) => {
      const q = shippingQuote(c);
      return q && !q.blocked ? q.rate : null;
    };
    assert.equal(rate('BE'), 8.5);
    for (const c of ['DE', 'FR', 'LU', 'NL']) assert.equal(rate(c), 9.95);
    for (const c of ['AT', 'ES', 'IT', 'PL', 'SE']) assert.equal(rate(c), 12.95);
    for (const c of ['CY', 'EE', 'MT']) assert.equal(rate(c), 16.95);
    for (const c of ['GB', 'CH', 'NO', 'IS', 'LI']) assert.equal(rate(c), 24.95);
    assert.equal(rate('US'), 19.95);
    for (const c of ['CA', 'AU', 'JP']) assert.equal(rate(c), 39.95);
  });

  it('bills Bulgaria at the rest-of-world rate with no import duty', () => {
    const q = shippingQuote('BG');
    assert.ok(q && !q.blocked);
    assert.equal(q.rate, 39.95);
    assert.equal(q.zone, 'world');
    assert.equal(q.duty, 'none');
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
    assert.equal(all.length, 26 + 5 + 1);
  });

  it('names a country in English', () => {
    assert.equal(countryName('BE'), 'Belgium');
    assert.equal(countryName('GB'), 'United Kingdom');
  });
});

describe('shipCountryOptions', () => {
  it('leaves out every blocked country and quotes a rate for every one it lists', () => {
    const codes = shipCountryOptions().map((o) => o.code);
    for (const blocked of BLOCKED_COUNTRIES) assert.ok(!codes.includes(blocked), blocked);
    assert.equal(codes.length, SHIP_COUNTRY_CODES.length);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) {
      const q = shippingQuote(code);
      assert.ok(q && !q.blocked, code);
    }
    for (const c of ['BE', 'US', 'GB', 'BG', 'JP']) assert.ok(codes.includes(c), c);
  });

  it('sorts by country name', () => {
    const names = shipCountryOptions().map((o) => o.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
    assert.equal(shipCountryOptions().find((o) => o.code === 'BE')?.name, 'Belgium');
  });
});

describe('shipCountryPicker', () => {
  it('lists Belgium, the Netherlands, Germany, France and Luxembourg first', () => {
    const {likely, rest} = shipCountryPicker();
    assert.deepEqual(likely.map((o) => o.code), ['BE', 'NL', 'DE', 'FR', 'LU']);
    assert.deepEqual(likely.map((o) => o.rate), [8.5, 9.95, 9.95, 9.95, 9.95]);
    assert.equal(likely[0].name, 'Belgium');
    for (const code of LIKELY_SHIP_COUNTRIES) assert.ok(!rest.some((o) => o.code === code), code);
    assert.equal(likely.length + rest.length, SHIP_COUNTRY_CODES.length);
    const names = rest.map((o) => o.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
    assert.equal(rest.find((o) => o.code === 'US')?.rate, 19.95);
  });

  it('leaves out uninhabited territories and blocked countries', () => {
    const {likely, rest} = shipCountryPicker();
    const codes = [...likely, ...rest].map((o) => o.code);
    for (const c of ['AQ', 'BV', 'HM', 'GS', 'TF', 'UM', 'IO']) {
      assert.ok(UNINHABITED_TERRITORIES.has(c), c);
      assert.ok(!codes.includes(c), c);
    }
    for (const c of BLOCKED_COUNTRIES) assert.ok(!codes.includes(c), c);
    for (const o of [...likely, ...rest]) assert.ok(o.rate > 0, o.code);
  });
});

describe('default destination', () => {
  const req = (headers: Record<string, string>, query = '') =>
    new Request(`https://example.test/products/x${query}`, {headers});

  it('reads the region from Accept-Language by weight, skipping bare languages', () => {
    assert.equal(countryFromAcceptLanguage('de-DE,de;q=0.9,en;q=0.8'), 'DE');
    assert.equal(countryFromAcceptLanguage('de,en-US;q=0.5'), 'US');
    assert.equal(countryFromAcceptLanguage('en-GB;q=0.4,fr-BE;q=0.8'), 'BE');
    assert.equal(countryFromAcceptLanguage('zh-Hant-TW'), 'TW');
    assert.equal(countryFromAcceptLanguage('es-419,fr'), null);
    assert.equal(countryFromAcceptLanguage('de'), null);
    assert.equal(countryFromAcceptLanguage(null), null);
  });

  it('keeps only a shippable pick in the cookie', () => {
    assert.equal(shipCountryCookie('de'), 'od_ship_country=DE; Path=/; Max-Age=31536000; SameSite=Lax; Secure');
    assert.equal(shipCountryCookie('NL', false), 'od_ship_country=NL; Path=/; Max-Age=31536000; SameSite=Lax');
    assert.equal(shipCountryCookie('RU'), null);
    assert.equal(shipCountryCookie('AQ'), null);
    assert.equal(shipCountryCookie('ZZ'), null);
    assert.equal(shipCountryFromCookie('a=1; od_ship_country=FR; b=2'), 'FR');
    assert.equal(shipCountryFromCookie('od_ship_country=RU'), null);
    assert.equal(shipCountryFromCookie('xod_ship_country=FR'), null);
    assert.equal(shipCountryFromCookie(undefined), null);
  });

  it('orders query, cookie, CF-IPCountry, Accept-Language', () => {
    const all = {Cookie: 'od_ship_country=NL', 'CF-IPCountry': 'BE', 'Accept-Language': 'de-DE'};
    assert.equal(shipCountryForRequest(req(all, '?country=us')), 'US');
    assert.equal(shipCountryForRequest(req(all)), 'NL');
    assert.equal(shipCountryForRequest(req({'CF-IPCountry': 'BE', 'Accept-Language': 'de-DE'})), 'BE');
    assert.equal(shipCountryForRequest(req({'CF-IPCountry': 'XX', 'Accept-Language': 'de-DE'})), 'DE');
    assert.equal(shipCountryForRequest(req({'CF-IPCountry': 'T1'})), null);
    // A blocked IP country stays visible so the page can say so.
    assert.equal(shipCountryForRequest(req({'CF-IPCountry': 'RU'})), 'RU');
    assert.equal(shipCountryForRequest(req({})), null);
  });
});
