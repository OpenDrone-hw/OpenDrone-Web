import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {MARKETS_PATH, chooseCountry, filterGroups, flatOptions, pickerGroups, pickerLabel} from './country-picker.ts';
import {getPendingShipTo, setPendingShipTo, withPendingShipTo} from './pending-ship-to.ts';
import {geoAvailabilityRegion} from './geo-availability.ts';
import {regionFor} from './region.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('country picker: the pill', () => {
  it('reads the country and the currency, compact', () => {
    assert.equal(pickerLabel(regionFor('BE', 'geo', true)), 'BE · EUR');
    assert.equal(pickerLabel(regionFor('US', 'geo', true)), 'US · USD');
    assert.equal(pickerLabel(regionFor('CH', 'geo', true)), 'CH · EUR');
    assert.equal(pickerLabel(regionFor(null, 'default', true)), 'Country · EUR');
  });
});

describe('country picker: one searchable list', () => {
  const groups = pickerGroups(9.95);
  it('lists every country once: most orders first, then the EU, then the rest', () => {
    assert.deepEqual(groups.map((g) => g.id), ['pinned', 'eu', 'world']);
    assert.deepEqual(groups[0].options.map((o) => o.code), ['BE', 'NL', 'DE', 'FR', 'LU', 'US']);
    const codes = flatOptions(groups).map((o) => o.code);
    assert.equal(new Set(codes).size, codes.length);
    assert.ok(codes.length > 200);
  });
  it('searches by name start, word start or code, accents ignored', () => {
    assert.deepEqual(flatOptions(filterGroups(groups, 'germ')).map((o) => o.code), ['DE']);
    assert.deepEqual(flatOptions(filterGroups(groups, 'kingdom')).map((o) => o.code), ['GB']);
    assert.ok(flatOptions(filterGroups(groups, 'ch')).some((o) => o.code === 'CH'));
    assert.ok(flatOptions(filterGroups(groups, 'reunion')).some((o) => o.code === 'RE'));
    assert.deepEqual(filterGroups(groups, 'zzzz'), []);
    assert.equal(filterGroups(groups, '  '), groups);
  });
  it('the US is listed only while it is sold direct', () => {
    assert.ok(!pickerGroups(null)[0].options.some((o) => o.code === 'US'));
  });
});

describe('country picker: a choice sets the region through the resolver', () => {
  it('choosing a country gives that country and the market the resolver maps it to', () => {
    const ch = chooseCountry('BE', 'ch', true)!;
    assert.equal(ch.country, 'CH');
    assert.deepEqual(ch.region, regionFor('CH', 'choice', true));
    assert.equal(ch.region.market, 'import');
    assert.equal(chooseCountry('BE', 'US', true)!.region.currency, 'USD');
    assert.equal(chooseCountry('BE', 'DE', true)!.region.lanes.buyNow, true);
    assert.equal(chooseCountry('DE', 'CA', true)!.region.lanes.buyNow, false);
  });
  it('the same country, or anything that is not a country code, changes nothing', () => {
    assert.equal(chooseCountry('BE', 'be', true), null);
    assert.equal(chooseCountry('BE', '', true), null);
    assert.equal(chooseCountry('BE', 'BEL', true), null);
  });
});

describe('country picker: header, drawer and cart stay in sync', () => {
  it('one component everywhere: header pill, phone drawer, cart, added-to-cart dialog', () => {
    assert.match(read('../components/Header.tsx'), /<CountryPicker className="header-region-switch" \/>/);
    assert.match(read('../components/PageLayout.tsx'), /<CountryPicker variant="field"/);
    assert.match(read('../routes/cart.$.tsx'), /<CountryPicker\s+variant="field"\s+country=\{country\}/);
    assert.match(read('../components/CartAddedDialog.tsx'), /<CountryPicker\s+variant="field"/);
    for (const gone of ['RegionSwitch', 'ShipToSelect']) {
      for (const file of ['../components/Header.tsx', '../components/PageLayout.tsx', '../routes/cart.$.tsx', '../components/CartAddedDialog.tsx']) {
        assert.doesNotMatch(read(file), new RegExp(gone), `${file} still uses ${gone}`);
      }
    }
  });
  it('a choice in flight shows in every picker and the bar at once (the shared pending country)', () => {
    const picker = read('../components/CountryPicker.tsx');
    assert.match(picker, /const current = pendingCountry \?\? confirmed;/);
    const root = {};
    setPendingShipTo('ch', root);
    assert.equal(getPendingShipTo(), 'CH');
    const geo = withPendingShipTo({country: 'BE', region: geoAvailabilityRegion('BE'), locale: 'en' as const}, getPendingShipTo(), geoAvailabilityRegion);
    assert.equal(geo?.country, 'CH');
    setPendingShipTo(null);
    assert.equal(getPendingShipTo(), null);
  });
  it('the cart is quoted for the pending country too', () => {
    assert.match(read('../routes/cart.$.tsx'), /cartQuoteCountry\(pendingShipTo \?\? country \?\? cart\.country/);
  });
});

describe('country picker: nothing but countries, and one link', () => {
  const picker = read('../components/CountryPicker.tsx');
  it('carries no market groups or tax sentences', () => {
    assert.doesNotMatch(picker, /VAT|duties|import charges|region_switch/i);
    assert.doesNotMatch(read('../../content/copy/chrome.json'), /region_switch/);
  });
  it('links "How prices and shipping work" to /markets', () => {
    assert.equal(MARKETS_PATH, '/markets');
    assert.match(picker, /'How prices and shipping work'/);
    assert.match(picker, /to=\{MARKETS_PATH\}/);
  });
});
