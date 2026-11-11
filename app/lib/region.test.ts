import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {listedMarkets, marketCountry, regionFor, resolveRegion, type Region} from './region.ts';
import {countryLinkRedirect, queryCountryCookie, resolveCountry, shipCountryCookie} from './shipping-rates.ts';

const req = (headers: Record<string, string>, path = '/products/openfc-lite') =>
  new Request(`https://opendrone.be${path}`, {headers});

describe('resolveCountry precedence', () => {
  const all = {Cookie: 'od_ship_country=NL', 'CF-IPCountry': 'US', 'Accept-Language': 'de-DE'};

  it('blocked IP beats everything', () => {
    assert.deepEqual(resolveCountry(req({...all, 'CF-IPCountry': 'RU'}, '/x?country=BE')), {country: 'RU', source: 'blocked-ip'});
  });
  it('a link beats the cookie (the landing request, before the redirect lands)', () => {
    assert.deepEqual(resolveCountry(req(all, '/x?country=gb')), {country: 'GB', source: 'link'});
  });
  it('the choice cookie beats the IP', () => {
    assert.deepEqual(resolveCountry(req(all)), {country: 'NL', source: 'choice'});
  });
  it('the IP country when there is no choice', () => {
    assert.deepEqual(resolveCountry(req({'CF-IPCountry': 'JP'})), {country: 'JP', source: 'geo'});
  });
  it('never the browser language: unknown IP is the default', () => {
    assert.deepEqual(resolveCountry(req({'CF-IPCountry': 'XX', 'Accept-Language': 'en-US'})), {country: null, source: 'default'});
    assert.deepEqual(resolveCountry(req({'CF-IPCountry': 'T1'})), {country: null, source: 'default'});
    assert.deepEqual(resolveCountry(req({})), {country: null, source: 'default'});
  });
  it('ignores a cookie for a country the picker does not list', () => {
    assert.deepEqual(resolveCountry(req({Cookie: 'od_ship_country=ZW', 'CF-IPCountry': 'BE'})), {country: 'BE', source: 'geo'});
  });
});

describe('country links act once (the "cannot choose US / USD" fault)', () => {
  it('a page load with ?country redirects without it and stores the choice', () => {
    const res = countryLinkRedirect(req({Cookie: 'od_ship_country=US'}, '/products/openfc-lite?country=BE&image=2'))!;
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Location'), '/products/openfc-lite?image=2');
    assert.match(res.headers.get('Set-Cookie') ?? '', /od_ship_country=BE/);
  });
  it('a revalidation (.data) never writes the link back over a later pick', () => {
    const data = req({Cookie: 'od_ship_country=US'}, '/products/openfc-lite.data?country=BE');
    assert.equal(queryCountryCookie(data), null);
    assert.equal(countryLinkRedirect(data), null);
  });
  it('leaves form routes and POSTs alone', () => {
    assert.equal(countryLinkRedirect(req({}, '/shop/cart?country=DE')), null);
    assert.equal(countryLinkRedirect(req({}, '/api/shopify/cart?country=DE')), null);
    assert.equal(countryLinkRedirect(new Request('https://opendrone.be/x?country=DE', {method: 'POST'})), null);
    assert.equal(countryLinkRedirect(req({}, '/products.json?country=DE')), null);
  });
  it('a blocked IP is redirected too but gets no cookie', () => {
    const res = countryLinkRedirect(req({'CF-IPCountry': 'RU'}, '/?country=BE'))!;
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('Set-Cookie'), null);
  });
  it('no parameter, no redirect', () => {
    assert.equal(countryLinkRedirect(req({})), null);
  });
});

/** One row of the region matrix: the region a visitor gets. */
type Row = [label: string, headers: Record<string, string>, expect: Partial<Region> & {buyNow: boolean; preorder: boolean; ships: boolean}];

const ROWS: Row[] = [
  ['BE', {'CF-IPCountry': 'BE'}, {market: 'eu', currency: 'EUR', taxes: 'eu-vat-included', shopifyMarket: 'be', buyNow: true, preorder: true, ships: true}],
  ['DE', {'CF-IPCountry': 'DE'}, {market: 'eu', currency: 'EUR', taxes: 'eu-vat-included', shopifyMarket: 'international', buyNow: true, preorder: true, ships: true}],
  ['NL', {'CF-IPCountry': 'NL'}, {market: 'eu', currency: 'EUR', buyNow: true, preorder: true, ships: true}],
  ['FR', {'CF-IPCountry': 'FR'}, {market: 'eu', currency: 'EUR', buyNow: true, preorder: true, ships: true}],
  ['IE', {'CF-IPCountry': 'IE'}, {market: 'eu', currency: 'EUR', taxes: 'eu-vat-included', buyNow: true, preorder: true, ships: true}],
  ['GB: pre-order only, import VAT on delivery', {'CF-IPCountry': 'GB'}, {market: 'import', currency: 'EUR', taxes: 'import-on-delivery', buyNow: false, preorder: true, ships: true}],
  ['CH', {'CF-IPCountry': 'CH'}, {market: 'import', currency: 'EUR', buyNow: false, preorder: true, ships: true}],
  ['NO', {'CF-IPCountry': 'NO'}, {market: 'import', currency: 'EUR', buyNow: false, preorder: true, ships: true}],
  ['US', {'CF-IPCountry': 'US'}, {market: 'us', currency: 'USD', taxes: 'us-duties-included', shopifyMarket: 'us', buyNow: false, preorder: true, ships: true}],
  ['CA', {'CF-IPCountry': 'CA'}, {market: 'world', currency: 'EUR', taxes: 'import-on-delivery', buyNow: false, preorder: true, ships: true}],
  ['AU', {'CF-IPCountry': 'AU'}, {market: 'world', currency: 'EUR', buyNow: false, preorder: true, ships: true}],
  ['JP', {'CF-IPCountry': 'JP'}, {market: 'world', currency: 'EUR', buyNow: false, preorder: true, ships: true}],
  ['KR', {'CF-IPCountry': 'KR'}, {market: 'world', currency: 'EUR', buyNow: false, preorder: true, ships: true}],
  ['BR', {'CF-IPCountry': 'BR'}, {market: 'world', currency: 'EUR', buyNow: false, preorder: true, ships: true}],
  ['ZW: no Shopify route', {'CF-IPCountry': 'ZW'}, {market: 'none', buyNow: false, preorder: false, ships: false}],
  ['IM: no Shopify route', {'CF-IPCountry': 'IM'}, {market: 'none', buyNow: false, preorder: false, ships: false}],
  ['PR: no Shopify route', {'CF-IPCountry': 'PR'}, {market: 'none', buyNow: false, preorder: false, ships: false}],
  ['RU: blocked', {'CF-IPCountry': 'RU', Cookie: 'od_ship_country=BE'}, {market: 'none', buyNow: false, preorder: false, ships: false}],
  ['unknown / VPN: home market, pre-order only', {'CF-IPCountry': 'XX', 'Accept-Language': 'en-US'}, {market: 'eu', currency: 'EUR', country: null, buyNow: false, preorder: true, ships: true}],
  // Chosen region in the header beats the IP country.
  ['US IP, chose EU (BE)', {'CF-IPCountry': 'US', Cookie: 'od_ship_country=BE'}, {market: 'eu', currency: 'EUR', buyNow: true, preorder: true, ships: true}],
  ['BE IP, chose US', {'CF-IPCountry': 'BE', Cookie: 'od_ship_country=US'}, {market: 'us', currency: 'USD', buyNow: false, preorder: true, ships: true}],
  ['GB IP, chose EU (DE)', {'CF-IPCountry': 'GB', Cookie: 'od_ship_country=DE'}, {market: 'eu', currency: 'EUR', buyNow: true, preorder: true, ships: true}],
  ['JP IP, chose US', {'CF-IPCountry': 'JP', Cookie: 'od_ship_country=US'}, {market: 'us', currency: 'USD', buyNow: false, preorder: true, ships: true}],
];

describe('region matrix (US gate open)', () => {
  for (const [label, headers, expect] of ROWS) {
    it(label, () => {
      const region = resolveRegion(req(headers), true);
      const {buyNow, preorder, ships, ...fields} = expect;
      for (const [key, value] of Object.entries(fields)) assert.deepEqual(region[key as keyof Region], value, `${label}: ${key}`);
      assert.equal(region.lanes.buyNow, buyNow, `${label}: buyNow`);
      assert.equal(region.lanes.preorder, preorder, `${label}: preorder`);
      assert.equal(region.shipping.available, ships, `${label}: ships`);
      // Batch 1 (Buy now) is only ever offered to an EU country.
      if (region.lanes.buyNow) assert.equal(region.market, 'eu');
    });
  }
});

describe('region reasons', () => {
  it('names why a country cannot buy', () => {
    const reason = (country: string, usOpen = true) => {
      const s = regionFor(country, 'geo', usOpen).shipping;
      return s.available ? null : s.reason;
    };
    assert.equal(reason('RU'), 'blocked');
    assert.equal(reason('ZW'), 'no-route');
    assert.equal(reason('AQ'), 'no-route');
    assert.equal(reason('US', false), 'us-closed');
    assert.equal(reason('BE'), null);
  });
  it('an EU country not approved for sale is closed', () => {
    const region = regionFor('DE', 'geo', true, {DE: {weee: null, packaging: null, offerNeedsNumber: false, saleApproved: false}} as never);
    assert.equal(region.market, 'none');
    assert.deepEqual(region.shipping, {available: false, reason: 'not-approved'});
  });
});

describe('header control markets', () => {
  it('lists exactly the markets Shopify sells to', () => {
    assert.deepEqual(listedMarkets(true), ['eu', 'us', 'import', 'world']);
    assert.deepEqual(listedMarkets(false), ['eu', 'import', 'world']);
  });
  it('stores a real country for each market choice', () => {
    const sg = regionFor('SG', 'geo', true);
    assert.equal(marketCountry('us', sg, 'SG', true), 'US');
    assert.equal(marketCountry('eu', sg, 'SG', true), 'BE');
    assert.equal(marketCountry('import', sg, 'SG', true), 'GB');
    assert.equal(marketCountry('world', sg, 'SG', true), 'SG');
    const de = regionFor('DE', 'geo', true);
    assert.equal(marketCountry('eu', de, 'DE', true), 'DE');
    // EU visitor asking for "World": no country to guess, the country list asks.
    assert.equal(marketCountry('world', de, 'DE', true), null);
    // A JP visitor who chose US gets JP back from "World".
    assert.equal(marketCountry('world', regionFor('US', 'choice', true), 'JP', true), 'JP');
    assert.equal(marketCountry('us', sg, 'SG', false), null);
  });
  it('every stored country is one the cookie can hold', () => {
    for (const country of ['BE', 'DE', 'US', 'GB', 'SG', 'JP']) assert.ok(shipCountryCookie(country));
  });
});
