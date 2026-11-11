/**
 * The owners map's privacy rules, as pure functions (README "Owners map").
 *
 * Input: how many distinct paying customers ship to each country and, for the
 * United States, each state. Output: the only thing the site ever stores and
 * shows, a snapshot that says where owners are and never how many. Raw orders
 * and addresses never reach this module's output and are never stored.
 *
 * | Rule | Value |
 * |---|---|
 * | A region (country, or US state) is published at | 1 or more owners |
 * | Per region | a shading level only: 0 some, 1 more, 2 most, relative to the largest region of its kind (countries; US states), so it shows rank, not volume |
 * | Per region, in text | the name only, never a figure or range |
 * | Headline | a milestone: the largest of 100, 250, 500, 1000, 2500, 5000 the total has reached; none under 100 |
 * | Country count | floored to 10 with a plus ("30+"); none under 10 |
 * | US states | only where the United States itself is published |
 *
 * A region is one coarse attribute (country or state), so naming it singles
 * nobody out; the milestone moves only when a step is crossed and the 30-day
 * refresh keeps month-to-month differences from showing a single new order.
 * Region ids in a snapshot: `DE` (country), `US-CA` (US state). Kept free of
 * worker APIs and path aliases so node:test can load it directly.
 */
import {STATE_NAME} from './owner-map-geo.ts';

/** A snapshot older than this is recomputed by the scheduled job. */
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** After a failed or empty refresh the job waits this long before asking Shopify again. */
export const REFRESH_RETRY_MS = 6 * 60 * 60 * 1000;

/** Headline steps: the page shows the largest one the true total has reached. */
export const MILESTONES = [100, 250, 500, 1000, 2500, 5000] as const;

/** Shading levels: 0 some, 1 more, 2 most. */
export const LEVEL_COUNT = 3;
export type Level = 0 | 1 | 2;

/** Reserved rows in the snapshot table, next to the region rows. */
export const META_TOTAL = '_total';
export const META_COUNTRIES = '_countries';
export const META_ATTEMPT = '_attempt';
/** Marks rows written under these rules; older rows (ranges, rounded totals) are recomputed. */
export const META_VERSION = '_v2';

export type RawCounts = {
  /** Owners per ISO 3166-1 alpha-2 country code, the United States included. */
  countries: Record<string, number>;
  /** US owners per postal state code. */
  usStates: Record<string, number>;
};

export type Snapshot = {
  /** Epoch ms the counts were taken. */
  generatedAt: number;
  /** Largest milestone reached, or null under the first one. Never the total. */
  milestone: number | null;
  /** Countries with an owner, floored to 10, or null under 10. */
  countriesFloor: number | null;
  /** Region id to shading level. Only suppressed, published regions. */
  regions: Record<string, Level>;
};

/** Largest milestone the total has reached, or null. */
export function milestoneFor(total: number): number | null {
  let out: number | null = null;
  for (const step of MILESTONES) if (total >= step) out = step;
  return out;
}

/** Country count floored to 10, or null under 10. */
export function countryFloor(count: number): number | null {
  const floor = Math.floor(count / 10) * 10;
  return floor >= 10 ? floor : null;
}

/** Shading level of each count relative to the largest in its group: thirds of the maximum. */
function levels(counts: Record<string, number>): Record<string, Level> {
  const max = Math.max(0, ...Object.values(counts));
  const out: Record<string, Level> = {};
  for (const [id, count] of Object.entries(counts)) {
    out[id] = count * 3 >= max * 2 ? 2 : count * 3 >= max ? 1 : 0;
  }
  return out;
}

const isCode = (value: string) => /^[A-Z]{2}$/.test(value);

/** The only entry point for raw counts: applies every suppression rule. */
export function suppress(raw: RawCounts, generatedAt: number): Snapshot {
  const countries: Record<string, number> = {};
  for (const [code, count] of Object.entries(raw.countries)) {
    if (isCode(code) && Number.isFinite(count) && count >= 1) countries[code] = Math.floor(count);
  }
  const regions: Record<string, Level> = levels(countries);

  // State detail exists only where the United States itself is published.
  if (regions.US !== undefined) {
    const states: Record<string, number> = {};
    for (const [code, count] of Object.entries(raw.usStates)) {
      if (STATE_NAME[code] && Number.isFinite(count) && count >= 1) states[code] = Math.floor(count);
    }
    for (const [code, level] of Object.entries(levels(states))) regions[`US-${code}`] = level;
  }

  const sum = Object.values(countries).reduce((a, b) => a + b, 0);
  return {
    generatedAt,
    milestone: milestoneFor(sum),
    countriesFloor: countryFloor(Object.keys(countries).length),
    regions,
  };
}

/** What the browser gets: the snapshot without its timestamp, so the only numbers are the milestone, the floor and levels 0-2. */
export type PublicSnapshot = Omit<Snapshot, 'generatedAt'>;

export function publicSnapshot(snapshot: Snapshot | null): PublicSnapshot | null {
  if (!snapshot) return null;
  const {generatedAt: _at, ...rest} = snapshot;
  return rest;
}

export type SnapshotRow = {region: string; generated_at: number; bucket: number};

/** The rows `owner_map_snapshot` holds for a snapshot (migration 0009; `bucket` stores the value). */
export function snapshotRows(snapshot: Snapshot): SnapshotRow[] {
  const at = snapshot.generatedAt;
  return [
    {region: META_VERSION, generated_at: at, bucket: 0},
    {region: META_TOTAL, generated_at: at, bucket: snapshot.milestone ?? 0},
    {region: META_COUNTRIES, generated_at: at, bucket: snapshot.countriesFloor ?? 0},
    ...Object.entries(snapshot.regions).map(([region, level]) => ({region, generated_at: at, bucket: level})),
  ];
}

/** Rebuild a snapshot from stored rows; null when there is none or it predates these rules. Bad rows are dropped. */
export function snapshotFromRows(rows: SnapshotRow[]): Snapshot | null {
  const data = rows.filter((r) => r.region !== META_ATTEMPT);
  const total = data.find((r) => r.region === META_TOTAL);
  const countries = data.find((r) => r.region === META_COUNTRIES);
  if (!total || !countries || !data.some((r) => r.region === META_VERSION)) return null;
  const regions: Record<string, Level> = {};
  for (const row of data) {
    if (row.region.startsWith('_')) continue;
    if (!Number.isInteger(row.bucket) || row.bucket < 0 || row.bucket >= LEVEL_COUNT) continue;
    regions[row.region] = row.bucket as Level;
  }
  return {
    generatedAt: total.generated_at,
    milestone: (MILESTONES as readonly number[]).includes(total.bucket) ? total.bucket : null,
    countriesFloor: countries.bucket >= 10 ? Math.floor(countries.bucket / 10) * 10 : null,
    regions,
  };
}

/** True when the stored snapshot is missing or older than 30 days. */
export function snapshotStale(snapshot: Pick<Snapshot, 'generatedAt'> | null, now: number): boolean {
  return !snapshot || now - snapshot.generatedAt >= SNAPSHOT_MAX_AGE_MS;
}

export type OwnerOrder = {
  test?: boolean;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  customer: {id: string} | null;
  email?: string | null;
  shippingAddress: {countryCodeV2: string | null; provinceCode: string | null} | null;
  lineItems: {nodes: Array<{requiresShipping: boolean}>};
};

const PAID = new Set(['PAID', 'PARTIALLY_REFUNDED']);

/** Paid or partly refunded, not cancelled, not a test, with at least one physical line. */
export function qualifies(order: OwnerOrder): boolean {
  return (
    !order.test &&
    !order.cancelledAt &&
    PAID.has(order.displayFinancialStatus ?? '') &&
    order.lineItems.nodes.some((line) => line.requiresShipping)
  );
}

/**
 * Distinct owners per shipping country and US state. A customer counts once,
 * where their latest qualifying order shipped (orders arrive oldest first).
 * A guest order falls back to its email address, held in memory only.
 */
export function tallyOwners(orders: OwnerOrder[]): RawCounts {
  const owners = new Map<string, {country: string; state: string | null}>();
  for (const order of orders) {
    if (!qualifies(order)) continue;
    const country = order.shippingAddress?.countryCodeV2?.toUpperCase() ?? '';
    if (!isCode(country)) continue;
    const key = order.customer?.id ?? (order.email ? `mail:${order.email.trim().toLowerCase()}` : '');
    if (!key) continue;
    const state = country === 'US' ? (order.shippingAddress?.provinceCode?.toUpperCase() ?? null) : null;
    owners.set(key, {country, state});
  }
  const raw: RawCounts = {countries: {}, usStates: {}};
  for (const {country, state} of owners.values()) {
    raw.countries[country] = (raw.countries[country] ?? 0) + 1;
    if (state) raw.usStates[state] = (raw.usStates[state] ?? 0) + 1;
  }
  return raw;
}

/**
 * Aggregate counts shaped like the real thing, for local development. Never
 * read orders in dev: this stands in for them (OWNER_MAP_FIXTURE, README).
 */
export function fixtureCounts(): RawCounts {
  const usStates: Record<string, number> = {
    CA: 8, TX: 7, WA: 7, FL: 5,
    NY: 4, CO: 4, IL: 3, OR: 3, PA: 3, MA: 3, GA: 2, AZ: 2, NC: 2, OH: 2,
    MI: 2, VA: 2, MN: 2, UT: 1, NV: 1, TN: 1, IN: 1, MO: 1, WI: 1, SC: 1,
  };
  const countries: Record<string, number> = {
    DE: 78, NL: 28, BE: 15, FR: 12, GB: 9, AT: 7, FI: 6, PL: 5, LT: 5,
    SE: 4, DK: 4, CA: 4, IE: 3, ES: 3, IT: 3, CH: 3, AU: 3, CZ: 2, PT: 2,
    NO: 2, JP: 2, NZ: 1, HU: 1, GR: 1, EE: 1,
  };
  countries.US = Object.values(usStates).reduce((a, b) => a + b, 0);
  return {countries, usStates};
}
