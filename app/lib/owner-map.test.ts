import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {
  META_ATTEMPT,
  SNAPSHOT_MAX_AGE_MS,
  countryFloor,
  fixtureCounts,
  milestoneFor,
  publicSnapshot,
  qualifies,
  snapshotFromRows,
  snapshotRows,
  snapshotStale,
  suppress,
  tallyOwners,
  type OwnerOrder,
  type RawCounts,
} from './owner-map.ts';
import {COUNTRY_BY_NUMERIC, STATE_BY_FIPS, US_STATES} from './owner-map-geo.ts';

const NOW = 1_800_000_000_000;
const raw = (countries: Record<string, number>, usStates: Record<string, number> = {}): RawCounts => ({countries, usStates});

describe('milestone and floor', () => {
  it('publishes the largest milestone reached, none under 100', () => {
    const cases: Array<[number, number | null]> = [
      [0, null], [99, null], [100, 100], [249, 100], [250, 250], [499, 250], [500, 500],
      [999, 500], [1000, 1000], [2499, 1000], [2500, 2500], [4999, 2500], [5000, 5000], [90000, 5000],
    ];
    for (const [total, step] of cases) assert.equal(milestoneFor(total), step, String(total));
  });

  it('floors the country count to 10, none under 10', () => {
    assert.equal(countryFloor(9), null);
    assert.equal(countryFloor(10), 10);
    assert.equal(countryFloor(29), 20);
    assert.equal(countryFloor(30), 30);
  });
});

describe('suppress: countries', () => {
  it('shades relative to the largest country: thirds of the maximum', () => {
    const s = suppress(raw({DE: 90, NL: 60, FR: 59, BE: 30, ES: 29, IT: 1}), NOW);
    assert.deepEqual(s.regions, {DE: 2, NL: 2, FR: 1, BE: 1, ES: 0, IT: 0});
  });

  it('shows rank, not volume: the same shape at another scale gives the same levels', () => {
    const small = suppress(raw({DE: 9, NL: 6, FR: 3, BE: 1}), NOW);
    const large = suppress(raw({DE: 900, NL: 600, FR: 300, BE: 100}), NOW);
    assert.deepEqual(small.regions, large.regions);
  });

  it('a single country is the most', () => {
    assert.deepEqual(suppress(raw({DE: 1}), NOW).regions, {DE: 2});
  });

  it('ignores malformed codes and non-positive counts', () => {
    const s = suppress(raw({DEU: 50, de: 50, XX: 0, '': 9, BE: -3, NL: 7}), NOW);
    assert.deepEqual(s.regions, {NL: 2});
    assert.equal(s.countriesFloor, null);
  });
});

describe('suppress: United States', () => {
  it('shades states relative to the largest state', () => {
    const s = suppress(raw({US: 20, DE: 40}, {CA: 9, TX: 5, NY: 2, WY: 1}), NOW);
    assert.deepEqual(s.regions, {DE: 2, US: 1, 'US-CA': 2, 'US-TX': 1, 'US-NY': 0, 'US-WY': 0});
  });

  it('drops unknown state codes and non-positive counts', () => {
    const s = suppress(raw({US: 12}, {CA: 6, ZZ: 6, TX: 0}), NOW);
    assert.deepEqual(s.regions, {US: 2, 'US-CA': 2});
  });

  it('publishes no state without the United States', () => {
    const s = suppress(raw({FR: 6}, {CA: 4}), NOW);
    assert.deepEqual(s.regions, {FR: 2});
  });
});

describe('suppress: headline', () => {
  it('carries a milestone and a country floor, never the total', () => {
    const countries = Object.fromEntries(Array.from({length: 12}, (_, i) => [`A${String.fromCharCode(65 + i)}`, 30]));
    const s = suppress(raw(countries), NOW);
    assert.equal(s.milestone, 250);
    assert.equal(s.countriesFloor, 10);
    assert.ok(!('total' in s) && !('countries' in s));
  });

  it('shows no total under 100 and no country count under 10', () => {
    const s = suppress(raw({DE: 60, FR: 39}), NOW);
    assert.equal(s.milestone, null);
    assert.equal(s.countriesFloor, null);
    assert.equal(suppress(raw({DE: 60, FR: 40}), NOW).milestone, 100);
  });

  it('is empty for no owners', () => {
    assert.deepEqual(suppress(raw({}), NOW), {generatedAt: NOW, milestone: null, countriesFloor: null, regions: {}});
  });
});

describe('public snapshot', () => {
  it('has no number but the milestone, the country floor and levels 0-2', () => {
    const numbers: number[] = [];
    JSON.parse(JSON.stringify(publicSnapshot(suppress(fixtureCounts(), NOW))), function (key, value) {
      if (typeof value === 'number') numbers.push(value);
      return value;
    });
    const s = suppress(fixtureCounts(), NOW);
    const allowed = new Set<number>([s.milestone!, s.countriesFloor!, 0, 1, 2]);
    for (const n of numbers) assert.ok(allowed.has(n), String(n));
    assert.ok(!('generatedAt' in publicSnapshot(s)!));
  });
});

describe('fixture', () => {
  it('suppresses into levels, a milestone and a floor', () => {
    const s = suppress(fixtureCounts(), NOW);
    for (const code of ['DE', 'NL', 'BE', 'FR', 'GB', 'AT', 'FI', 'PL', 'LT', 'US']) {
      assert.ok(s.regions[code] !== undefined, code);
    }
    assert.equal(s.regions.DE, 2);
    assert.equal(s.regions.NL, 1);
    assert.ok(s.regions['US-CA'] !== undefined && s.regions['US-FL'] !== undefined);
    assert.ok(Object.values(s.regions).includes(0));
    assert.equal(s.milestone, 250);
    assert.equal(s.countriesFloor, 20);
  });
});

describe('snapshot rows', () => {
  it('round-trips and ignores the attempt row', () => {
    const s = suppress(fixtureCounts(), NOW);
    const rows = [...snapshotRows(s), {region: META_ATTEMPT, generated_at: NOW + 5, bucket: 0}];
    assert.deepEqual(snapshotFromRows(rows), s);
  });

  it('round-trips a hidden milestone and floor', () => {
    const s = suppress(raw({DE: 6}), NOW);
    assert.deepEqual(snapshotFromRows(snapshotRows(s)), s);
  });

  it('returns null without meta rows or for rows written under the old range rules', () => {
    assert.equal(snapshotFromRows([]), null);
    const old = snapshotRows(suppress(raw({DE: 6}), NOW)).filter((r) => r.region !== '_v2');
    assert.equal(snapshotFromRows(old), null);
  });

  it('drops out-of-range levels', () => {
    const rows = snapshotRows(suppress(raw({DE: 6, FR: 6}), NOW));
    rows.push({region: 'ES', generated_at: NOW, bucket: 3});
    assert.deepEqual(Object.keys(snapshotFromRows(rows)!.regions).sort(), ['DE', 'FR']);
  });

  it('is stale when missing or 30 days old', () => {
    assert.equal(snapshotStale(null, NOW), true);
    assert.equal(snapshotStale({generatedAt: NOW - SNAPSHOT_MAX_AGE_MS + 1}, NOW), false);
    assert.equal(snapshotStale({generatedAt: NOW - SNAPSHOT_MAX_AGE_MS}, NOW), true);
  });
});

type OrderOver = Partial<OwnerOrder> & {country?: string; state?: string | null; id?: string | null};

function order(over: OrderOver = {}): OwnerOrder {
  const {country = 'BE', state = null, id = 'c1', ...rest} = over;
  return {
    test: false,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    customer: id ? {id} : null,
    email: null,
    shippingAddress: {countryCodeV2: country, provinceCode: state},
    lineItems: {nodes: [{requiresShipping: true}]},
    ...rest,
  };
}

describe('qualifies and tallyOwners', () => {
  it('requires paid, not cancelled, not test, and a physical line', () => {
    assert.equal(qualifies(order()), true);
    assert.equal(qualifies(order({displayFinancialStatus: 'PARTIALLY_REFUNDED'})), true);
    assert.equal(qualifies(order({displayFinancialStatus: 'PENDING'})), false);
    assert.equal(qualifies(order({displayFinancialStatus: 'REFUNDED'})), false);
    assert.equal(qualifies(order({displayFinancialStatus: 'AUTHORIZED'})), false);
    assert.equal(qualifies(order({cancelledAt: '2026-09-01T00:00:00Z'})), false);
    assert.equal(qualifies(order({test: true})), false);
    assert.equal(qualifies(order({lineItems: {nodes: [{requiresShipping: false}]}})), false);
  });

  it('counts a customer once, in the country of the latest order', () => {
    const raw = tallyOwners([
      order({id: 'a', country: 'BE'}),
      order({id: 'a', country: 'NL'}),
      order({id: 'b', country: 'NL'}),
    ]);
    assert.deepEqual(raw.countries, {NL: 2});
  });

  it('tracks US states and skips orders without a shipping address', () => {
    const raw = tallyOwners([
      order({id: 'a', country: 'US', state: 'ca'}),
      order({id: 'b', country: 'US', state: 'CA'}),
      order({id: 'c', country: 'US', state: null}),
      order({id: 'd', shippingAddress: null}),
      order({id: 'e', country: 'DE', state: 'BY'}),
    ]);
    assert.deepEqual(raw.countries, {US: 3, DE: 1});
    assert.deepEqual(raw.usStates, {CA: 2});
  });

  it('falls back to the email for a guest and skips an order with neither', () => {
    const raw = tallyOwners([
      order({id: null, email: 'A@x.test'}),
      order({id: null, email: 'a@x.test '}),
      order({id: null, email: null}),
    ]);
    assert.deepEqual(raw.countries, {BE: 1});
  });

  it('does not count a cancelled later order over an earlier paid one', () => {
    const raw = tallyOwners([order({country: 'BE'}), order({country: 'NL', cancelledAt: '2026-09-01T00:00:00Z'})]);
    assert.deepEqual(raw.countries, {BE: 1});
  });
});

describe('geo tables', () => {
  it('maps every US state once and has 51 entries', () => {
    assert.equal(US_STATES.length, 51);
    assert.equal(new Set(US_STATES.map(([code]) => code)).size, 51);
    assert.equal(STATE_BY_FIPS['06'], 'CA');
  });

  it('covers the countries the map must colour', () => {
    const codes = new Set(Object.values(COUNTRY_BY_NUMERIC));
    for (const code of ['BE', 'NL', 'DE', 'FR', 'GB', 'US', 'FI', 'PL', 'LT', 'AT', 'JP', 'AU']) {
      assert.ok(codes.has(code), code);
    }
  });

  it('uses current ISO codes, not the retired ones Intl also knows', () => {
    const retired = new Set(['FX', 'UK', 'DY', 'TP', 'SU', 'YU', 'HV', 'ZR', 'BU']);
    for (const code of Object.values(COUNTRY_BY_NUMERIC)) assert.ok(!retired.has(code), code);
    assert.equal(COUNTRY_BY_NUMERIC['643'], 'RU');
    assert.equal(COUNTRY_BY_NUMERIC['826'], 'GB');
    assert.equal(COUNTRY_BY_NUMERIC['250'], 'FR');
  });

  it('lists every boundary country of the shipped atlas', () => {
    const atlas = JSON.parse(readFileSync(new URL('../../public/geo/countries-110m.json', import.meta.url), 'utf8')) as {
      objects: {countries: {geometries: Array<{id?: string; properties: {name: string}}>}};
    };
    const missing = atlas.objects.countries.geometries
      .filter((g) => g.id && !COUNTRY_BY_NUMERIC[g.id])
      .map((g) => g.properties.name);
    assert.deepEqual(missing, []);
  });
});

describe('deployment gate', () => {
  it('keeps the fixture flag out of the production config', () => {
    for (const file of ['wrangler.production.toml', 'wrangler.toml']) {
      const toml = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(toml, /^\s*OWNER_MAP_FIXTURE\s*=/m, file);
    }
  });
});
