import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {formatLine1, pickCountry, postcodeFirst, postcodeKey, requestCountry, AUTOCOMPLETE} from './address-fields.ts';
import {addressProvider, cleanQuery, geoapify, lastProviderStatus, none, photon} from './address-provider.ts';
import {expressConfig, fromPaymentResponse} from './payment-provider.ts';

const json = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

describe('country default', () => {
  it('uses the visitor country when shipped, else the first shipped country', () => {
    assert.equal(pickCountry('nl', ['BE', 'NL', 'DE']), 'NL');
    assert.equal(pickCountry('US', ['BE', 'NL']), 'BE');
    assert.equal(pickCountry(null, ['DE', 'BE']), 'DE');
    assert.equal(pickCountry('FR', []), 'FR');
    assert.equal(pickCountry('zzz', undefined), 'BE');
  });
  it('reads request.cf.country before the header and ignores unknown markers', () => {
    const req = new Request('https://x.test/', {headers: {'CF-IPCountry': 'DE'}});
    assert.equal(requestCountry(req), 'DE');
    assert.equal(requestCountry(Object.assign(new Request('https://x.test/'), {cf: {country: 'NL'}})), 'NL');
    assert.equal(requestCountry(new Request('https://x.test/', {headers: {'CF-IPCountry': 'XX'}})), null);
    assert.equal(requestCountry(new Request('https://x.test/', {headers: {'CF-IPCountry': 'T1'}})), null);
  });
});

describe('field order and autocomplete', () => {
  it('puts the postcode before the city in BE, NL, DE, FR and after it in GB', () => {
    for (const c of ['BE', 'NL', 'DE', 'FR']) assert.equal(postcodeFirst(c), true);
    assert.equal(postcodeFirst('GB'), false);
  });
  it('orders street and number by country', () => {
    assert.equal(formatLine1('Wetstraat', '16', 'BE'), 'Wetstraat 16');
    assert.equal(formatLine1('Rue de la Paix', '12', 'FR'), '12 Rue de la Paix');
    assert.equal(formatLine1('Damrak', '', 'NL'), 'Damrak');
  });
  it('uses the HTML autofill tokens in the shipping section', () => {
    assert.equal(AUTOCOMPLETE.line1, 'shipping address-line1');
    assert.equal(AUTOCOMPLETE.postal_code, 'shipping postal-code');
    assert.equal(AUTOCOMPLETE.city, 'shipping address-level2');
    assert.equal(AUTOCOMPLETE.country, 'shipping country');
  });
  it('reads a postcode key per country', () => {
    assert.equal(postcodeKey('BE', '3000'), '3000');
    assert.equal(postcodeKey('NL', '1012 LG'), '1012');
    assert.equal(postcodeKey('DE', '1011'), null);
    assert.equal(postcodeKey('GB', 'SW1A 1AA'), null);
  });
});

describe('address provider', () => {
  it('is none unless configured, and geoapify needs its key', () => {
    assert.equal(addressProvider({}).id, 'none');
    assert.equal(addressProvider({ADDRESS_PROVIDER: 'photon'}).id, 'photon');
    assert.equal(addressProvider({ADDRESS_PROVIDER: 'geoapify'}).id, 'none');
    assert.equal(addressProvider({ADDRESS_PROVIDER: 'geoapify', GEOAPIFY_API_KEY: 'k'}).id, 'geoapify');
  });
  it('cleans queries and demands three characters', () => {
    assert.equal(cleanQuery('ab'), null);
    assert.equal(cleanQuery('  Wet\nstraat   16 '), 'Wet straat 16');
    assert.equal(cleanQuery('x'.repeat(500))?.length, 120);
  });
  it('maps photon results, filters to the country and puts the number by country', async () => {
    const f = json({features: [
      {properties: {street: 'Wetstraat', housenumber: '16', postcode: '1000', city: 'Brussels', countrycode: 'BE'}},
      {properties: {street: 'Rue de la Loi', housenumber: '16', postcode: '67120', city: 'Dorlisheim', countrycode: 'FR'}},
      {properties: {name: 'Nowhere', countrycode: 'BE'}},
    ]});
    assert.deepEqual(await photon.suggest('Wetstraat 16', 'BE', f), [{label: 'Wetstraat 16, 1000 Brussels', line1: 'Wetstraat 16', postal_code: '1000', city: 'Brussels'}]);
    assert.equal((await photon.suggest('Rue', 'FR', f))[0].line1, '16 Rue de la Loi');
  });
  it('maps geoapify results and sends the key and country filter', async () => {
    let seen = '';
    const f = (async (url: string) => ((seen = url), new Response(JSON.stringify({results: [{street: 'Damrak', housenumber: '1', postcode: '1012 LG', city: 'Amsterdam'}]})))) as unknown as typeof fetch;
    const out = await geoapify('KEY').suggest('Damrak', 'NL', f);
    assert.equal(out[0].label, 'Damrak 1, 1012 LG Amsterdam');
    assert.match(seen, /filter=countrycode%3Anl/);
    assert.match(seen, /apiKey=KEY/);
  });
  it('answers with nothing when the provider fails or times out', async () => {
    assert.deepEqual(await photon.suggest('abc', 'BE', (async () => { throw new Error('down'); }) as typeof fetch), []);
    assert.deepEqual(await photon.suggest('abc', 'BE', (async () => new Response('no', {status: 429})) as typeof fetch), []);
    assert.deepEqual(await none.suggest('abc', 'BE'), []);
  });
});

describe('express wallets', () => {
  it('draw nothing without a provider and its publishable key', () => {
    assert.equal(expressConfig({}), null);
    assert.equal(expressConfig({EXPRESS_PAY_PROVIDER: 'stripe'}), null);
    assert.equal(expressConfig({EXPRESS_PAY_PROVIDER: 'stripe', STRIPE_PUBLISHABLE_KEY: 'sk_live_secret'}), null);
    assert.equal(expressConfig({EXPRESS_PAY_PROVIDER: 'mollie', STRIPE_PUBLISHABLE_KEY: 'pk_test_1'}), null);
    assert.equal(expressConfig({EXPRESS_PAY_PROVIDER: 'stripe', STRIPE_PUBLISHABLE_KEY: 'pk_test_1'})?.provider, 'stripe');
  });
  it('maps a payment response to the form fields', () => {
    const r = fromPaymentResponse({payerName: 'Ann', payerEmail: 'a@x.test', shippingAddress: {addressLine: ['Wetstraat 16', 'Bus 2'], postalCode: '1000', city: 'Brussels', country: 'be'}});
    assert.deepEqual(r.address, {line1: 'Wetstraat 16', line2: 'Bus 2', postal_code: '1000', city: 'Brussels', country: 'BE'});
    assert.equal(r.name, 'Ann');
  });
});

describe('postcode tables', () => {
  it('hold, per country, keys the form can look up and at least one city each', async () => {
    const {readFileSync} = await import('node:fs');
    const {POSTCODE_COUNTRIES} = await import('./address-fields.ts');
    for (const cc of POSTCODE_COUNTRIES) {
      const table = JSON.parse(readFileSync(new URL(`../../data/postcodes/${cc}.json`, import.meta.url), 'utf8')) as Record<string, string[]>;
      const keys = Object.keys(table);
      assert.ok(keys.length > 500, cc);
      for (const k of keys.slice(0, 200)) assert.equal(postcodeKey(cc, k), k, `${cc} ${k}`);
      assert.ok(Object.values(table).every((c) => c.length > 0), cc);
    }
    assert.deepEqual((JSON.parse(readFileSync(new URL('../../data/postcodes/BE.json', import.meta.url), 'utf8')) as Record<string, string[]>)['3000'], ['Leuven']);
  });
});

describe('address provider status', () => {
  it('records a refused lookup so the route can say why the list is empty', async () => {
    const refused = (async () => new Response('no', {status: 403})) as typeof fetch;
    assert.deepEqual(await photon.suggest('Wetstraat 16', 'BE', refused), []);
    assert.equal(lastProviderStatus(), '403');
    assert.deepEqual(await photon.suggest('Wetstraat 16', 'BE', (async () => { throw new Error('down'); }) as typeof fetch), []);
    assert.equal(lastProviderStatus(), 'error');
  });
});

describe('checkout class names', () => {
  it('the address dropdown and the add-ons block do not share a class (a shared one drew the add-ons over the form on a phone)', () => {
    const addr = readFileSync(new URL('../../components/commerce/AddressFields.tsx', import.meta.url), 'utf8');
    const extras = readFileSync(new URL('../../components/commerce/SummarySuggestions.tsx', import.meta.url), 'utf8');
    const own = (src: string) => new Set([...src.matchAll(/className="([a-z0-9-]+)"/g)].map((m) => m[1]).filter((c) => c.startsWith('co-')));
    const shared = [...own(addr)].filter((c) => own(extras).has(c));
    assert.deepEqual(shared, []);
  });
});

describe('geoapify request', () => {
  it('asks for buildings and streets (no type filter), so a typed house number finds the building', async () => {
    let url = '';
    const f = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({results: [{street: 'Bondgenotenlaan', housenumber: '9', postcode: '3000', city: 'Leuven', country_code: 'be'}]}), {status: 200});
    }) as unknown as typeof fetch;
    const out = await geoapify('KEY').suggest('Bondgenotenlaan 9', 'BE', f);
    assert.doesNotMatch(url, /[?&]type=/);
    assert.match(url, /filter=countrycode%3Abe/);
    assert.equal(out[0]?.label, 'Bondgenotenlaan 9, 3000 Leuven');
  });
});
