import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {paysEuVat, priceNote, visitorCountry} from './visitor-country.ts';

const req = (url: string, country?: string) =>
  new Request(url, {headers: country ? {'CF-IPCountry': country} : {}});

describe('visitorCountry', () => {
  it('reads the Cloudflare header and lets ?country override it', () => {
    assert.equal(visitorCountry(req('https://opendrone.be/p', 'us')), 'US');
    assert.equal(visitorCountry(req('https://opendrone.be/p?country=be', 'US')), 'BE');
  });

  it('ignores unknown or malformed values', () => {
    assert.equal(visitorCountry(req('https://opendrone.be/p', 'XX')), null);
    assert.equal(visitorCountry(req('https://opendrone.be/p?country=usa')), null);
    assert.equal(visitorCountry(req('https://opendrone.be/p')), null);
  });
});

describe('paysEuVat', () => {
  it('is true inside the EU and for an unknown country, false outside', () => {
    assert.equal(paysEuVat('BE'), true);
    assert.equal(paysEuVat(null), true);
    assert.equal(paysEuVat('US'), false);
    assert.equal(paysEuVat('CH'), false);
  });
});

describe('priceNote', () => {
  it('tells EU visitors from the ones who buy through shops', () => {
    assert.equal(priceNote('NL'), 'vat');
    assert.equal(priceNote(null), 'vat');
    assert.equal(priceNote('US'), 'shops');
    assert.equal(priceNote('GB'), 'shops');
  });
});
