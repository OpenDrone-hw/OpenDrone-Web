/**
 * The owners map's privacy rules, as pure functions (README "Owners map").
 *
 * Input: how many distinct paying customers ship to each country and, for the
 * United States, each state. Output: the only thing the site ever stores and
 * shows, a snapshot of buckets. Raw orders and addresses never reach this
 * module's output and are never stored.
 *
 * | Rule | Value |
 * |---|---|
 * | A region (country, or US state) is published at | 1 or more owners |
 * | Published values | buckets (1-4, 5-9, ...), never exact counts |
 * | US states | only where the United States itself is published |
 * | Headline | total rounded down to 10, hidden under 10, plus the country count |
 *
 * A region is one coarse attribute (country or state), so a bucket of 1-4
 * singles nobody out; buckets and the 30-day refresh keep month-to-month
 * differences from showing a single new order. Region ids in a snapshot: `DE`
 * (country), `US-CA` (US state). Kept free of worker APIs and path aliases so
 * node:test can load it directly.
 */
import {STATE_NAME} from './owner-map-geo.ts';

/** A snapshot older than this is recomputed by the scheduled job. */
export const SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** After a failed or empty refresh the job waits this long before asking Shopify again. */
export const REFRESH_RETRY_MS = 6 * 60 * 60 * 1000;

const BUCKET_LOWER = [1, 5, 10, 25, 50, 100, 250, 500] as const;
const BUCKET_LABELS = ['1-4', '5-9', '10-24', '25-49', '50-99', '100-249', '250-499', '500+'] as const;

/** Number of buckets; a bucket index runs 0 to BUCKET_COUNT - 1. */
export const BUCKET_COUNT = BUCKET_LABELS.length;

/** Reserved rows in the snapshot table, next to the region rows. */
export const META_TOTAL = '_total';
export const META_COUNTRIES = '_countries';
export const META_ATTEMPT = '_attempt';

export type RawCounts = {
  /** Owners per ISO 3166-1 alpha-2 country code, the United States included. */
  countries: Record<string, number>;
  /** US owners per postal state code. */
  usStates: Record<string, number>;
};

export type Snapshot = {
  /** Epoch ms the counts were taken. */
  generatedAt: number;
  /** Total owners rounded down to 10, or null when under 10. */
  total: number | null;
  /** Countries with at least one owner. */
  countries: number;
  /** Region id to bucket index. Only suppressed, published regions. */
  regions: Record<string, number>;
};

/** Bucket index for a count, or -1 for no owners. */
export function bucketIndex(count: number): number {
  let index = -1;
  for (let i = 0; i < BUCKET_LOWER.length; i += 1) {
    if (count >= BUCKET_LOWER[i]!) index = i;
  }
  return index;
}

/** "10-24", "500+". */
export function bucketLabel(index: number): string {
  return BUCKET_LABELS[index] ?? '';
}

export function roundDownTo10(count: number): number {
  return Math.floor(count / 10) * 10;
}

const isCode = (value: string) => /^[A-Z]{2}$/.test(value);

/** The only entry point for raw counts: applies every suppression rule. */
export function suppress(raw: RawCounts, generatedAt: number): Snapshot {
  const regions: Record<string, number> = {};
  const countries: Record<string, number> = {};
  for (const [code, count] of Object.entries(raw.countries)) {
    if (isCode(code) && Number.isFinite(count) && count > 0) countries[code] = Math.floor(count);
  }

  for (const [code, count] of Object.entries(countries)) regions[code] = bucketIndex(count);

  // State detail exists only where the United States itself is published.
  if (regions.US !== undefined) {
    for (const [code, count] of Object.entries(raw.usStates)) {
      if (!STATE_NAME[code] || !Number.isFinite(count) || count < 1) continue;
      regions[`US-${code}`] = bucketIndex(Math.floor(count));
    }
  }

  const sum = Object.values(countries).reduce((a, b) => a + b, 0);
  const rounded = roundDownTo10(sum);
  return {
    generatedAt,
    total: rounded >= 10 ? rounded : null,
    countries: Object.keys(countries).length,
    regions,
  };
}

export type SnapshotRow = {region: string; generated_at: number; bucket: number};

/** The rows `owner_map_snapshot` holds for a snapshot (migration 0009). */
export function snapshotRows(snapshot: Snapshot): SnapshotRow[] {
  const at = snapshot.generatedAt;
  return [
    {region: META_TOTAL, generated_at: at, bucket: snapshot.total ?? 0},
    {region: META_COUNTRIES, generated_at: at, bucket: snapshot.countries},
    ...Object.entries(snapshot.regions).map(([region, bucket]) => ({region, generated_at: at, bucket})),
  ];
}

/** Rebuild a snapshot from stored rows; null when there is none. Bad rows are dropped. */
export function snapshotFromRows(rows: SnapshotRow[]): Snapshot | null {
  const data = rows.filter((r) => r.region !== META_ATTEMPT);
  const total = data.find((r) => r.region === META_TOTAL);
  const countries = data.find((r) => r.region === META_COUNTRIES);
  if (!total || !countries) return null;
  const regions: Record<string, number> = {};
  for (const row of data) {
    if (row.region.startsWith('_')) continue;
    if (!Number.isInteger(row.bucket) || row.bucket < 0 || row.bucket >= BUCKET_COUNT) continue;
    regions[row.region] = row.bucket;
  }
  return {
    generatedAt: total.generated_at,
    total: total.bucket >= 10 ? total.bucket : null,
    countries: countries.bucket,
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
