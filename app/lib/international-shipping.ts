/**
 * The international shipping charge before checkout, read from the rates
 * configured in Shopify (Settings > Shipping), never from a copy here.
 *
 * Shopify charges an international cart the cheapest active rate of the
 * destination's zone whose weight range holds the cart's product weight
 * (both bounds inclusive; no package weight is added). This module computes
 * that same figure, and gives up (null) whenever it cannot be sure: more
 * than one delivery profile, a carrier-calculated rate, a condition other
 * than weight, a variant without a weight, a zone that does not name the
 * country, a cart priced in another currency than the rate, or a read that
 * failed. Null keeps the "calculated at checkout" wording.
 */

/** One flat rate and the weight range it applies to, in grams. */
export type FlatRate = {amount: number; currency: string; minGrams: number | null; maxGrams: number | null};

/** One shipping zone: its countries and its flat rates, or `exact: false`
 *  when a rate in it cannot be computed here. */
export type RateZone = {countries: string[]; restOfWorld: boolean; rates: FlatRate[]; exact: boolean};

/** What the computation needs from Shopify: the zones of the one delivery
 *  profile and every variant's weight in grams. */
export type ShippingTable = {zones: RateZone[]; grams: Record<string, number>};

type Money = {amount: string; currencyCode: string};
type Weight = {value: number; unit: string};

const GRAMS: Record<string, number> = {GRAMS: 1, KILOGRAMS: 1000, OUNCES: 28.349523125, POUNDS: 453.59237};

/** A weight in grams, rounded to a milligram so sums compare exactly. */
export function toGrams(weight: Weight | null | undefined): number | null {
  if (!weight || !Number.isFinite(weight.value) || weight.value < 0) return null;
  const factor = GRAMS[weight.unit];
  return factor ? Math.round(weight.value * factor * 1000) / 1000 : null;
}

type MethodNode = {
  active: boolean;
  rateProvider: {__typename: string; price?: Money};
  methodConditions: Array<{field: string; operator: string; conditionCriteria: {__typename: string} & Partial<Weight>}>;
};
type ZoneNode = {
  zone: {countries: Array<{code: {countryCode: string | null; restOfWorld: boolean}}>};
  methodDefinitions: {pageInfo: {hasNextPage: boolean}; nodes: MethodNode[]};
};

/** One zone from the Admin API, with only what Shopify's weight-based
 *  flat rates can express marked exact. */
export function parseZone(node: ZoneNode): RateZone {
  const countries = node.zone.countries.map((c) => c.code.countryCode).filter((c): c is string => Boolean(c));
  const restOfWorld = node.zone.countries.some((c) => c.code.restOfWorld);
  let exact = !node.methodDefinitions.pageInfo.hasNextPage;
  const rates: FlatRate[] = [];
  for (const method of node.methodDefinitions.nodes) {
    if (!method.active) continue;
    const price = method.rateProvider.__typename === 'DeliveryRateDefinition' ? method.rateProvider.price : undefined;
    const amount = Number(price?.amount);
    if (!price || !Number.isFinite(amount) || amount < 0) {
      exact = false;
      continue;
    }
    let minGrams: number | null = null;
    let maxGrams: number | null = null;
    for (const condition of method.methodConditions) {
      const grams = condition.conditionCriteria.__typename === 'Weight'
        ? toGrams(condition.conditionCriteria as Weight)
        : null;
      if (condition.field !== 'TOTAL_WEIGHT' || grams === null) {
        exact = false;
      } else if (condition.operator === 'GREATER_THAN_OR_EQUAL_TO') {
        minGrams = grams;
      } else if (condition.operator === 'LESS_THAN_OR_EQUAL_TO') {
        maxGrams = grams;
      } else {
        exact = false;
      }
    }
    rates.push({amount, currency: price.currencyCode, minGrams, maxGrams});
  }
  return {countries, restOfWorld, rates, exact};
}

/**
 * The charge Shopify checkout shows first for this cart, as a number in the
 * cart's currency, or null when it cannot be computed exactly.
 */
export function cheapestRate(
  table: ShippingTable,
  country: string,
  lines: ReadonlyArray<{merchandiseId: string; quantity: number}>,
  currency: string,
): number | null {
  const zone =
    table.zones.find((z) => z.countries.includes(country)) ??
    table.zones.find((z) => z.restOfWorld);
  if (!zone || !zone.exact || !lines.length) return null;
  let grams = 0;
  for (const line of lines) {
    const each = table.grams[line.merchandiseId];
    if (each === undefined || !Number.isSafeInteger(line.quantity) || line.quantity < 1) return null;
    grams += each * line.quantity;
  }
  grams = Math.round(grams * 1000) / 1000;
  let best: number | null = null;
  for (const rate of zone.rates) {
    if (rate.currency !== currency) return null;
    if (rate.minGrams !== null && grams < rate.minGrams) continue;
    if (rate.maxGrams !== null && grams > rate.maxGrams) continue;
    if (best === null || rate.amount < best) best = rate.amount;
  }
  return best;
}

type AdminEnv = {
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_ADMIN_API_TOKEN?: string;
  SHOPIFY_ADMIN_API_VERSION?: string;
};

const DEFAULT_ADMIN_API_VERSION = '2026-07';
const MAX_PAGES = 20;
const TTL_MS = 5 * 60 * 1000;

const PROFILES_QUERY = `#graphql
  query ShippingProfiles {
    deliveryProfiles(first: 3) {
      nodes {
        id
        profileLocationGroups { locationGroup { id } }
      }
    }
  }
`;

const ZONES_QUERY = `#graphql
  query ShippingZones($id: ID!, $group: ID!, $after: String) {
    deliveryProfile(id: $id) {
      profileLocationGroups(locationGroupId: $group) {
        locationGroupZones(first: 25, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            zone { countries { code { countryCode restOfWorld } } }
            methodDefinitions(first: 15) {
              pageInfo { hasNextPage }
              nodes {
                active
                rateProvider {
                  __typename
                  ... on DeliveryRateDefinition { price { amount currencyCode } }
                }
                methodConditions {
                  field
                  operator
                  conditionCriteria {
                    __typename
                    ... on Weight { value unit }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const WEIGHTS_QUERY = `#graphql
  query VariantWeights($after: String) {
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id inventoryItem { measurement { weight { value unit } } } }
    }
  }
`;

async function admin<T>(env: AdminEnv, query: string, variables: Record<string, unknown>, fetcher: typeof fetch): Promise<T> {
  const domain = env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || DEFAULT_ADMIN_API_VERSION;
  if (!domain || !token || !/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(domain) || !/^\d{4}-(01|04|07|10)$/.test(version)) {
    throw new Error('shipping rates: Admin API is not configured');
  }
  const response = await fetcher(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
    body: JSON.stringify({query, variables}),
    redirect: 'manual',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`shipping rates: Admin API returned ${response.status}`);
  }
  const result = (await response.json()) as {data?: T; errors?: unknown[]};
  if (result.errors?.length || !result.data) throw new Error('shipping rates: Admin API rejected the query');
  return result.data;
}

/** Read the shipping table from Shopify. Throws when it cannot be read or
 *  does not have the one-profile shape this module computes. */
export async function fetchShippingTable(env: AdminEnv, fetcher: typeof fetch = fetch): Promise<ShippingTable> {
  const profiles = await admin<{deliveryProfiles: {nodes: Array<{id: string; profileLocationGroups: Array<{locationGroup: {id: string}}>}>}}>(
    env, PROFILES_QUERY, {}, fetcher,
  );
  const [profile, ...others] = profiles.deliveryProfiles.nodes;
  // A second profile (or location group) splits a cart into parcels with a
  // charge each: not computed here.
  if (!profile || others.length || profile.profileLocationGroups.length !== 1) {
    throw new Error('shipping rates: not a single delivery profile');
  }
  const group = profile.profileLocationGroups[0].locationGroup.id;
  const zones: RateZone[] = [];
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error('shipping rates: too many zones');
    type Page = {deliveryProfile: {profileLocationGroups: Array<{locationGroupZones: {pageInfo: {hasNextPage: boolean; endCursor: string | null}; nodes: ZoneNode[]}}>}};
    const data: Page = await admin<Page>(env, ZONES_QUERY, {id: profile.id, group, after}, fetcher);
    const connection = data.deliveryProfile.profileLocationGroups[0]?.locationGroupZones;
    if (!connection) throw new Error('shipping rates: location group missing');
    zones.push(...connection.nodes.map(parseZone));
    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
    if (!after) throw new Error('shipping rates: pagination cursor is missing');
  }
  const grams: Record<string, number> = {};
  after = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error('shipping rates: too many variants');
    type Page = {productVariants: {pageInfo: {hasNextPage: boolean; endCursor: string | null}; nodes: Array<{id: string; inventoryItem: {measurement: {weight: Weight | null}} | null}>}};
    const data: Page = await admin<Page>(env, WEIGHTS_QUERY, {after}, fetcher);
    for (const variant of data.productVariants.nodes) {
      const g = toGrams(variant.inventoryItem?.measurement.weight);
      if (g !== null) grams[variant.id] = g;
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
    if (!after) throw new Error('shipping rates: pagination cursor is missing');
  }
  return {zones, grams};
}

let memo: {table: ShippingTable | null; fetchedAt: number} | null = null;

/** {@link fetchShippingTable}, reused for five minutes per isolate. A failed
 *  read is remembered as null for the same time, so the cart never waits on
 *  a failing Admin API twice in a row. */
export async function shippingTable(env: AdminEnv, now = Date.now(), fetcher: typeof fetch = fetch): Promise<ShippingTable | null> {
  if (!env.SHOPIFY_ADMIN_API_TOKEN?.trim()) return null;
  if (memo && now - memo.fetchedAt < TTL_MS) return memo.table;
  let table: ShippingTable | null = null;
  try {
    table = await fetchShippingTable(env, fetcher);
  } catch (error) {
    console.error('[shipping-rates]', error instanceof Error ? error.message : 'unknown error');
  }
  memo = {table, fetchedAt: now};
  return table;
}

export function resetShippingTableMemo(): void {
  memo = null;
}

/** The international charge for this cart, or null to keep the
 *  "calculated at checkout" wording. Never throws. */
export async function internationalShippingFrom(
  env: AdminEnv,
  country: string,
  cart: {lines: ReadonlyArray<{merchandiseId: string; quantity: number}>; subtotal: {currencyCode: string}},
): Promise<Money | null> {
  const table = await shippingTable(env);
  if (!table) return null;
  const amount = cheapestRate(table, country, cart.lines, cart.subtotal.currencyCode);
  return amount === null ? null : {amount: amount.toFixed(2), currencyCode: cart.subtotal.currencyCode};
}
