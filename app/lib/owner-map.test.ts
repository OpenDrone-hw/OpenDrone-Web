import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {
  BUCKET_COUNT,
  META_ATTEMPT,
  SNAPSHOT_MAX_AGE_MS,
  bucketIndex,
  bucketLabel,
  fixtureCounts,
  qualifies,
  roundDownTo10,
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

describe('buckets', () => {
  it('maps counts to the eight published ranges', () => {
    const cases: Array<[number, number]> = [
      [0, -1], [1, 0], [4, 0], [5, 1], [9, 1], [10, 2], [24, 2], [25, 3], [49, 3],
      [50, 4], [99, 4], [100, 5], [249, 5], [250, 6], [499, 6], [500, 7], [12000, 7],
    ];
    for (const [count, index] of cases) assert.equal(bucketIndex(count), index, String(count));
    assert.deepEqual(
      Array.from({length: BUCKET_COUNT}, (_, i) => bucketLabel(i)),
      ['1-4', '5-9', '10-24', '25-49', '50-99', '100-249', '250-499', '500+'],
    );
  });

  it('rounds the headline down to ten', () => {
    assert.equal(roundDownTo10(9), 0);
    assert.equal(roundDownTo10(10), 10);
    assert.equal(roundDownTo10(199), 190);
  });
});

describe('suppress: countries', () => {
  it('publishes every country with an owner, small ones as 1-4', () => {
    const s = suppress(raw({DE: 5, FR: 4, ES: 1}), NOW);
    assert.deepEqual(s.regions, {DE: 1, FR: 0, ES: 0});
  });

  it('never exposes an exact count, only a bucket index', () => {
    const s = suppress(raw({DE: 78, NL: 28, MX: 1}), NOW);
    assert.deepEqual(s.regions, {DE: 4, NL: 3, MX: 0});
    assert.ok(!JSON.stringify(s).includes('78'));
  });

  it('ignores malformed codes and non-positive counts', () => {
    const s = suppress(raw({DEU: 50, de: 50, XX: 0, '': 9, BE: -3, NL: 7}), NOW);
    assert.deepEqual(s.regions, {NL: 1});
    assert.equal(s.countries, 1);
  });
});

describe('suppress: United States', () => {
  it('publishes every state with an owner', () => {
    const s = suppress(raw({US: 20}, {CA: 8, TX: 5, NY: 4, WY: 1}), NOW);
    assert.deepEqual(s.regions, {US: 2, 'US-CA': 1, 'US-TX': 1, 'US-NY': 0, 'US-WY': 0});
  });

  it('drops unknown state codes and non-positive counts', () => {
    const s = suppress(raw({US: 12}, {CA: 6, ZZ: 6, TX: 0}), NOW);
    assert.deepEqual(s.regions, {US: 2, 'US-CA': 1});
  });

  it('publishes no state without the United States', () => {
    const s = suppress(raw({FR: 6}, {CA: 4}), NOW);
    assert.deepEqual(s.regions, {FR: 1});
  });
});

describe('suppress: headline', () => {
  it('rounds total down to 10 and counts countries with any owner', () => {
    const s = suppress(raw({DE: 78, NL: 28, FR: 1, ES: 2}), NOW);
    assert.equal(s.total, 100);
    assert.equal(s.countries, 4);
  });

  it('hides the total under 10', () => {
    assert.equal(suppress(raw({DE: 9}), NOW).total, null);
    assert.equal(suppress(raw({DE: 6, FR: 3}), NOW).total, null);
    assert.equal(suppress(raw({DE: 6, FR: 4}), NOW).total, 10);
  });

  it('is empty for no owners', () => {
    assert.deepEqual(suppress(raw({}), NOW), {generatedAt: NOW, total: null, countries: 0, regions: {}});
  });
});

describe('fixture', () => {
  it('suppresses into the shape the spec describes', () => {
    const s = suppress(fixtureCounts(), NOW);
    for (const code of ['DE', 'NL', 'BE', 'FR', 'GB', 'AT', 'FI', 'PL', 'LT', 'US']) {
      assert.ok(s.regions[code] !== undefined, code);
    }
    assert.equal(s.regions.DE, 4);
    assert.equal(s.regions.NL, 3);
    assert.ok(s.regions['US-CA'] !== undefined && s.regions['US-FL'] !== undefined);
    assert.ok(Object.values(s.regions).includes(0), 'small regions are published as 1-4');
    assert.ok(s.total !== null && s.total >= 100);
  });
});

describe('snapshot rows', () => {
  it('round-trips and ignores the attempt row', () => {
    const s = suppress(fixtureCounts(), NOW);
    const rows = [...snapshotRows(s), {region: META_ATTEMPT, generated_at: NOW + 5, bucket: 0}];
    assert.deepEqual(snapshotFromRows(rows), s);
  });

  it('round-trips a hidden total', () => {
    const s = suppress(raw({DE: 6}), NOW);
    assert.deepEqual(snapshotFromRows(snapshotRows(s)), s);
  });

  it('returns null without meta rows and drops out-of-range buckets', () => {
    assert.equal(snapshotFromRows([]), null);
    const rows = snapshotRows(suppress(raw({DE: 6, FR: 6}), NOW));
    rows.push({region: 'ES', generated_at: NOW, bucket: 9});
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
