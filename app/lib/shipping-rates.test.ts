import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {
  BLOCKED_COUNTRIES,
  EU_COUNTRIES,
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
  soldThroughShops,
} from './shipping-rates.ts';

describe('shippingQuote', () => {
  const rate = (c: string) => {
    const q = shippingQuote(c);
    return q?.kind === 'direct' ? q.rate : null;
  };

  it('uses the flat bpost rate table inside the EU', () => {
    assert.equal(rate('BE'), 8.5);
    for (const c of ['DE', 'FR', 'LU', 'NL']) assert.equal(rate(c), 9.95);
    for (const c of ['AT', 'ES', 'IT', 'PL', 'SE']) assert.equal(rate(c), 12.95);
    for (const c of ['CY', 'EE', 'MT']) assert.equal(rate(c), 16.95);
  });

  it('sells Bulgaria direct at its own rate', () => {
    assert.deepEqual(shippingQuote('BG'), {country: 'BG', kind: 'direct', zone: 'eu_bg', rate: 39.95});
  });

  it('sells direct to exactly the EU27, each in one zone', () => {
    const all = SHIPPING_ZONES.flatMap((z) => z.countries);
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual([...all].sort(), [...EU_COUNTRIES].sort());
    assert.equal(EU_COUNTRIES.size, 27);
    for (const c of EU_COUNTRIES) assert.equal(shippingQuote(c)?.kind, 'direct', c);
  });

  it('sends every other country that is not blocked to the shops', () => {
    for (const c of ['US', 'GB', 'CH', 'NO', 'IS', 'LI', 'CA', 'AU', 'JP']) {
      assert.deepEqual(shippingQuote(c), {country: c, kind: 'shops'});
      assert.equal(soldThroughShops(c), true, c);
    }
    assert.equal(soldThroughShops('DE'), false);
    assert.equal(soldThroughShops('RU'), false);
    assert.equal(soldThroughShops(null), false);
  });

  it('does not sell to the blocked countries', () => {
    for (const c of ['RU', 'BY', 'IR', 'KP', 'SY', 'CU']) {
      assert.deepEqual(shippingQuote(c), {country: c, kind: 'blocked'});
    }
    assert.equal(BLOCKED_COUNTRIES.size, 6);
  });

  it('ignores an unknown or malformed country', () => {
    assert.equal(shippingQuote(null), null);
    assert.equal(shippingQuote('Belgium'), null);
    assert.equal(shippingQuote('ZZ'), null);
    assert.equal(shippingQuote('be')?.country, 'BE');
  });

  it('names a country in English', () => {
    assert.equal(countryName('BE'), 'Belgium');
    assert.equal(countryName('GB'), 'United Kingdom');
  });
});

describe('shipping page', () => {
  it('lists the rate table of the code in every language', () => {
    const rates = SHIPPING_ZONES.map((z) => z.rate).sort((a, b) => a - b);
    for (const locale of ['en', 'nl', 'fr']) {
      const md = fs.readFileSync(new URL(`../content/legal/${locale}/shipping.md`, import.meta.url), 'utf8');
      const listed = md
        .split('\n')
        .filter((line) => line.startsWith('|'))
        .map((line) => /(\d+)[.,](\d{2})/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(`${m[1]}.${m[2]}`))
        .sort((a, b) => a - b);
      assert.deepEqual(listed, rates, locale);
    }
  });
});

describe('shipCountryOptions', () => {
  it('leaves out every blocked country and quotes every one it lists', () => {
    const codes = shipCountryOptions().map((o) => o.code);
    for (const blocked of BLOCKED_COUNTRIES) assert.ok(!codes.includes(blocked), blocked);
    assert.equal(codes.length, SHIP_COUNTRY_CODES.length);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) {
      const q = shippingQuote(code);
      assert.ok(q && q.kind !== 'blocked', code);
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
    assert.equal(rest.find((o) => o.code === 'US')?.rate, null);
    assert.equal(rest.find((o) => o.code === 'BG')?.rate, 39.95);
  });

  it('leaves out uninhabited territories and blocked countries', () => {
    const {likely, rest} = shipCountryPicker();
    const codes = [...likely, ...rest].map((o) => o.code);
    for (const c of ['AQ', 'BV', 'HM', 'GS', 'TF', 'UM', 'IO']) {
      assert.ok(UNINHABITED_TERRITORIES.has(c), c);
      assert.ok(!codes.includes(c), c);
    }
    for (const c of BLOCKED_COUNTRIES) assert.ok(!codes.includes(c), c);
    // A rate for every EU country, "through shops" (null) for the others.
    for (const o of [...likely, ...rest]) {
      assert.equal(o.rate !== null && o.rate > 0, EU_COUNTRIES.has(o.code), o.code);
    }
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
