/**
 * Wholesale price-group codes follow every preorder price step, in the Worker.
 *
 * A retailer pays WHOLESALE_PERCENT off retail (a variant's compare-at price
 * while a step is below it, else its price), whatever step the variant is on,
 * on the prices of its own market (docs/wholesale.md "The rule"). Shopify
 * takes a percentage off the live price, so each retailer has up to GROUPS
 * customer-limited codes, one per price group: percentage =
 * 1 - (1 - rate) x retail / divisor / price, scoped to that group's variants.
 * Slot 1 is the code the retailer types (WS25-NAME); slots 2 to 4 are
 * WS25-NAME-G2 .. -G4 and the cart sends all of them (wholesale-codes.ts).
 *
 * This is a port of scripts/wholesale_lib.py and scripts/wholesale-sync.py
 * (the manual path; the maths must stay identical, see the parity tests).
 * It runs right after a price step is written (preorder-ops.ts) and once an
 * hour from the scheduled handler (server.ts) as the catch-up for any other
 * price change. Writes only while WHOLESALE_SYNC_WRITE_ENABLED is "1" and
 * never on staging (it shares the production store); otherwise it plans and
 * reports. Customers are read for their tags, tax exemptions and note only;
 * nothing personal is logged or returned.
 *
 * The Admin token needs read_customers, read_discounts and write_discounts.
 */

import {recordOps} from './preorder-ops-status.ts';

export const WHOLESALE_PERCENT = 25;
export const GROUPS = 4; // same number as WHOLESALE_GROUPS in wholesale-codes.ts
const DECIMALS = 4; // Shopify stores a discount percentage with 4 decimals
const PCT_TOLERANCE = 5e-5;
export const EXEMPTION = 'EU_REVERSE_CHARGE_EXEMPTION_RULE';
export const MAX_UNIT_DEVIATION = 0.02;
const OVERPAY_CENTS = 1;
export const CODE_RE = /^(WS(\d{1,2})-[A-Z0-9]{2,16})(?:-G([2-4]))?$/;
const DEFAULT_ADMIN_API_VERSION = '2026-07';

/** Standard VAT rate per EU member state (same table and sources as EU_VAT in scripts/wholesale_lib.py). */
export const EU_VAT: Record<string, number> = {
  AT: 20, BE: 21, BG: 20, HR: 25, CY: 19, CZ: 21, DK: 25, EE: 24, FI: 25.5, FR: 20,
  DE: 19, GR: 24, HU: 27, IE: 23, IT: 22, LV: 21, LT: 21, LU: 17, MT: 18, NL: 21,
  PL: 23, PT: 23, RO: 21, SK: 23, SI: 22, ES: 21, SE: 25,
};

export type LiveVariant = {id: string; sku: string; title: string; price: number; retail: number};
export type Group = {pct: number; variants: LiveVariant[]};
export type CustomerFacts = {tags?: string[] | null; taxExemptions?: string[] | null; note?: string | null};

export class GroupsDoNotFit extends Error {}

/** Python's round(x, d): half to even at an exact half, else nearest. */
export function pyRound(x: number, d: number): number {
  const m = 10 ** d;
  const y = x * m;
  const f = Math.floor(y);
  const r = y - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(y);
  return r / m;
}

export function slotCode(main: string, slot: number): string {
  return slot === 1 ? main : `${main}-G${slot}`;
}

export function label(v: Pick<LiveVariant, 'sku' | 'title'>): string {
  return v.title ? `${v.sku} (${v.title})` : v.sku;
}

/** 1 for everyone but a reverse-charge customer: then 1 + the standard VAT rate of its country. */
export function divisor(country: string | null, exempt: boolean): number {
  if (!exempt) return 1;
  const rate = country ? EU_VAT[country] : undefined;
  if (rate === undefined) throw new Error(`reverse charge for ${country ?? 'no country'}: no standard VAT rate`);
  return 1 + rate / 100;
}

/** The retailer's country: its country-xx tag, else the country of a VAT ID on its note (EL is GR). */
export function customerCountry(customer: CustomerFacts): string | null {
  for (const t of customer.tags ?? []) {
    if (t.startsWith('country-') && t.length === 10) return t.slice(-2).toUpperCase();
  }
  const m = /VAT ([A-Z]{2})[A-Z0-9]/.exec(customer.note ?? '');
  return m ? (m[1] === 'EL' ? 'GR' : m[1]) : null;
}

export function customerDivisor(customer: CustomerFacts): number {
  const exempt = (customer.taxExemptions ?? []).includes(EXEMPTION);
  return exempt ? divisor(customerCountry(customer), true) : 1;
}

/** What one unit costs above (+) or below (-) rate x retail after Shopify rounds the discount to cents. */
export function unitDeviation(v: LiveVariant, pct: number, ratePercent: number, div = 1): number {
  const wantUnit = (v.retail * (1 - ratePercent / 100)) / div;
  return v.price - pyRound(v.price * pct + 1e-9, 2) - wantUnit;
}

export function worstUnitCents(gs: Group[], ratePercent: number, div = 1): number {
  let worst = 0;
  for (const g of gs) for (const v of g.variants) worst = Math.max(worst, Math.abs(unitDeviation(v, g.pct, ratePercent, div)) * 100);
  return worst;
}

/** (worst per unit, worst per line up to maxQty) deviation in cents from rate x retail (wholesale_lib.rounding_check). */
export function roundingCheck(group: Group, ratePercent: number, maxQty = 50, div = 1): [number, number] {
  let unit = 0;
  let lineWorst = 0;
  for (const v of group.variants) {
    const wantUnit = (v.retail * (1 - ratePercent / 100)) / div;
    unit = Math.max(unit, Math.abs(unitDeviation(v, group.pct, ratePercent, div)) * 100);
    for (let q = 1; q <= maxQty; q++) {
      const line = pyRound(q * v.price, 2);
      const final = line - pyRound(line * group.pct + 1e-9, 2);
      lineWorst = Math.max(lineWorst, Math.abs(final - q * wantUnit) * 100);
    }
  }
  return [unit, lineWorst];
}

type Wanted = [number, LiveVariant];

function groupPct(items: Wanted[]): [number, number] {
  let lo = items[0][0];
  let hi = items[items.length - 1][0];
  const worst = (p: number) => Math.max(...items.map(([w, v]) => v.price * Math.abs(p - w)));
  for (let i = 0; i < 100; i++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (worst(a) <= worst(b)) hi = b;
    else lo = a;
  }
  const floor = Math.max(...items.map(([w, v]) => w - OVERPAY_CENTS / 100 / v.price));
  const p = Math.ceil(Math.max((lo + hi) / 2, floor) * 10 ** DECIMALS - 1e-6) / 10 ** DECIMALS;
  return [p, worst(p)];
}

/** At most GROUPS contiguous groups over the sorted wanted percentages, minimising the worst deviation (exact DP). */
export function cluster(wanted: Wanted[]): Group[] {
  const items = [...wanted].sort((x, y) => x[0] - y[0] || (x[1].id < y[1].id ? -1 : x[1].id > y[1].id ? 1 : 0));
  const n = items.length;
  const cost = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) for (let j = i + 1; j <= n; j++) cost.set(`${i},${j}`, groupPct(items.slice(i, j)));
  const best = new Map<string, [number, Array<[number, number]>]>([['0,0', [0, []]]]);
  for (let k = 1; k <= GROUPS; k++) {
    for (let j = 1; j <= n; j++) {
      let pick: [number, Array<[number, number]>] | null = null;
      for (let i = 0; i < j; i++) {
        const prev = best.get(`${k - 1},${i}`);
        if (!prev) continue;
        const option: [number, Array<[number, number]>] = [Math.max(prev[0], cost.get(`${i},${j}`)![1]), [...prev[1], [i, j]]];
        if (!pick || option[0] < pick[0]) pick = option;
      }
      if (pick) best.set(`${k},${j}`, pick);
    }
  }
  let chosen: [number, Array<[number, number]>] | null = null;
  for (let k = 1; k <= GROUPS; k++) {
    const b = best.get(`${k},${n}`);
    if (b && (!chosen || b[0] < chosen[0])) chosen = b;
  }
  return chosen![1].map(([i, j]) => ({pct: cost.get(`${i},${j}`)![0], variants: items.slice(i, j).map(([, v]) => v)}));
}

/** Price groups, largest first (slot 1). Throws GroupsDoNotFit when a unit would be off by more than MAX_UNIT_DEVIATION. */
export function groups(variants: LiveVariant[], ratePercent: number, div = 1): Group[] {
  const target = (1 - ratePercent / 100) / div;
  const wanted: Wanted[] = [];
  for (const v of variants) {
    const pct = pyRound(1 - (target * v.retail) / v.price, DECIMALS);
    if (pct > 0) wanted.push([pct, v]);
  }
  let out: Group[];
  if (new Set(wanted.map(([p]) => p)).size <= GROUPS) {
    const by = new Map<number, LiveVariant[]>();
    for (const [pct, v] of wanted) by.set(pct, [...(by.get(pct) ?? []), v]);
    out = [...by].map(([pct, vs]) => ({pct, variants: vs}));
  } else {
    out = cluster(wanted);
  }
  out.sort((a, b) => b.variants.length - a.variants.length || a.pct - b.pct);
  for (const g of out) {
    for (const v of g.variants) {
      const off = unitDeviation(v, g.pct, ratePercent, div);
      if (Math.abs(off) > MAX_UNIT_DEVIATION * v.price) {
        throw new GroupsDoNotFit(`${label(v)} would cost ${off.toFixed(2)} against ${ratePercent}% off retail; ${GROUPS} codes cannot price it`);
      }
    }
  }
  return out;
}

export type ExistingCode = {id: string; code: string; status: string; customers: string[]; pct: number | null; variants: string[]};
export type SlotAction = 'none' | 'create' | 'update' | 'deactivate';

export function planSlot(existing: ExistingCode | null, want: Group | null, customerIds: string[]): SlotAction {
  if (!want) return existing && existing.status === 'ACTIVE' ? 'deactivate' : 'none';
  if (!existing) return 'create';
  const ids = want.variants.map((v) => v.id).sort();
  const same =
    existing.status === 'ACTIVE' &&
    sameList(existing.customers, [...customerIds].sort()) &&
    sameList(existing.variants, ids) &&
    existing.pct !== null &&
    Math.abs(existing.pct - want.pct) < PCT_TOLERANCE;
  return same ? 'none' : 'update';
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Retail is the compare-at price while a step is below it, else the price (the retail step clears the compare-at). */
export function toLiveVariants(
  nodes: Array<{
    id: string; sku: string | null; title?: string | null; price: string; compareAtPrice: string | null;
    product: {status: string}; ctx?: {price?: {amount: string} | null; compareAtPrice?: {amount: string} | null} | null;
  }>,
  country: string | null,
): LiveVariant[] {
  const out: LiveVariant[] = [];
  for (const n of nodes) {
    if (n.product.status !== 'ACTIVE' || !n.sku) continue;
    const rawPrice = country ? n.ctx?.price?.amount ?? n.price : n.price;
    const rawCompare = country ? n.ctx?.compareAtPrice?.amount ?? null : n.compareAtPrice;
    const price = Number(rawPrice);
    const compare = rawCompare ? Number(rawCompare) : null;
    out.push({id: n.id, sku: n.sku, title: n.title ?? '', price, retail: compare && compare > price ? compare : price});
  }
  const key = (v: LiveVariant) => [v.sku, v.title, v.id];
  return out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
}

// ---------- Shopify Admin ----------

export type WholesaleEnv = Partial<
  Pick<Env, 'SHOPIFY_STORE_DOMAIN' | 'SHOPIFY_ADMIN_API_TOKEN' | 'SHOPIFY_ADMIN_API_VERSION' | 'STAGING_PASSWORD' | 'WHOLESALE_SYNC_WRITE_ENABLED'>
>;

/** Writes only with WHOLESALE_SYNC_WRITE_ENABLED "1" and never on staging, which shares the production store. */
export function wholesaleWritesEnabled(env: WholesaleEnv): boolean {
  return env.WHOLESALE_SYNC_WRITE_ENABLED?.trim() === '1' && !env.STAGING_PASSWORD?.trim();
}

export function wholesaleConfigured(env: WholesaleEnv): boolean {
  return Boolean(env.SHOPIFY_STORE_DOMAIN?.trim() && env.SHOPIFY_ADMIN_API_TOKEN?.trim());
}

export type Admin = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export function adminClient(env: WholesaleEnv, fetcher: typeof fetch): Admin {
  const domain = env.SHOPIFY_STORE_DOMAIN?.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = env.SHOPIFY_ADMIN_API_TOKEN?.trim();
  if (!domain || !token || !/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(domain)) {
    throw new Error('wholesale sync: Admin API is not configured');
  }
  const version = env.SHOPIFY_ADMIN_API_VERSION?.trim() || DEFAULT_ADMIN_API_VERSION;
  const url = `https://${domain}/admin/api/${version}/graphql.json`;
  return async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const mutation = query.trimStart().startsWith('mutation');
    for (let attempt = 0; ; attempt++) {
      const res = await fetcher(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Shopify-Access-Token': token},
        body: JSON.stringify({query, variables}),
      });
      if (!res.ok) throw new Error(`wholesale sync: HTTP ${res.status}`);
      const body = (await res.json()) as {data?: T; errors?: Array<{message?: string; extensions?: {code?: string}}>};
      const throttled = body.errors?.some((e) => e.extensions?.code === 'THROTTLED');
      if (throttled && !mutation && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (body.errors?.length) throw new Error(`wholesale sync: ${body.errors[0]?.message ?? 'GraphQL error'}`);
      if (!body.data) throw new Error('wholesale sync: no data');
      return body.data;
    }
  };
}

export function userErrors(payload: {userErrors?: Array<{message: string}>}): void {
  if (payload.userErrors?.length) throw new Error(`wholesale sync: ${payload.userErrors[0].message}`);
}

const CODES_QUERY = `query($a:String){codeDiscountNodes(first:8,after:$a){pageInfo{hasNextPage endCursor} nodes{id codeDiscount{... on DiscountCodeBasic{status codes(first:1){nodes{code}}
  context{... on DiscountCustomers{customers{id}}}
  customerGets{value{... on DiscountPercentage{percentage}} items{... on DiscountProducts{productVariants(first:100){nodes{id}}}}}}}}}}`;

type CodeNode = {
  id: string;
  codeDiscount: {
    status?: string;
    codes?: {nodes: Array<{code: string}>};
    context?: {customers?: Array<{id: string}>} | null;
    customerGets?: {value?: {percentage?: number} | null; items?: {productVariants?: {nodes: Array<{id: string}>}} | null} | null;
  } | null;
};

function toExisting(n: CodeNode, code: string): ExistingCode | null {
  const cd = n.codeDiscount;
  if (!cd) return null;
  return {
    id: n.id,
    code,
    status: cd.status ?? '',
    customers: (cd.context?.customers ?? []).map((c) => c.id).sort(),
    pct: cd.customerGets?.value?.percentage ?? null,
    variants: (cd.customerGets?.items?.productVariants?.nodes ?? []).map((v) => v.id).sort(),
  };
}

/** One code by its exact text (wholesale_lib.read_code), or null. */
export async function readCode(admin: Admin, code: string): Promise<ExistingCode | null> {
  const d = await admin<{codeDiscountNodeByCode: CodeNode | null}>(
    `query($c:String!){codeDiscountNodeByCode(code:$c){id codeDiscount{... on DiscountCodeBasic{status codes(first:1){nodes{code}}
  context{... on DiscountCustomers{customers{id}}}
  customerGets{value{... on DiscountPercentage{percentage}} items{... on DiscountProducts{productVariants(first:100){nodes{id}}}}}}}}}`,
    {c: code},
  );
  return d.codeDiscountNodeByCode ? toExisting(d.codeDiscountNodeByCode, code) : null;
}

/** Every wholesale code (main and group slots), keyed by code. */
async function wholesaleCodes(admin: Admin): Promise<Map<string, ExistingCode>> {
  const found = new Map<string, ExistingCode>();
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const d: {codeDiscountNodes: {pageInfo: {hasNextPage: boolean; endCursor: string | null}; nodes: CodeNode[]}} =
      await admin(CODES_QUERY, {a: after});
    for (const n of d.codeDiscountNodes.nodes) {
      const code = n.codeDiscount?.codes?.nodes[0]?.code;
      if (!code || !CODE_RE.test(code)) continue;
      found.set(code, toExisting(n, code)!);
    }
    if (!d.codeDiscountNodes.pageInfo.hasNextPage) break;
    after = d.codeDiscountNodes.pageInfo.endCursor;
  }
  return found;
}

async function customers(admin: Admin, ids: string[]): Promise<Map<string, CustomerFacts>> {
  const out = new Map<string, CustomerFacts>();
  if (!ids.length) return out;
  const d = await admin<{nodes: Array<({id: string} & CustomerFacts) | null>}>(
    'query($ids:[ID!]!){nodes(ids:$ids){... on Customer{id tags taxExemptions note}}}',
    {ids},
  );
  for (const c of d.nodes) if (c?.id) out.set(c.id, c);
  return out;
}

export async function liveVariants(admin: Admin, country: string | null): Promise<LiveVariant[]> {
  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('wholesale sync: bad country');
  const ctx = country ? ` ctx:contextualPricing(context:{country:${country}}){price{amount} compareAtPrice{amount}}` : '';
  const d = await admin<{productVariants: {nodes: Parameters<typeof toLiveVariants>[0]}}>(
    `{productVariants(first:100,query:"sku:OPEN*"){nodes{id sku title price compareAtPrice product{status}${ctx}}}}`,
  );
  return toLiveVariants(d.productVariants.nodes, country);
}

/** The International market's base-price list (-17.3554%), as wholesale_lib.base_price_problem. */
const BASE_DECREASE_PCT = 17.3554;
const BASE_DECREASE_TOLERANCE = 0.01; // Shopify stores the adjustment with two decimals
const INTERNATIONAL_HANDLE = 'international';

/** null when the International market carries the base-price list, else the reason (wholesale_lib.base_price_problem). */
export async function basePriceProblem(admin: Admin): Promise<string | null> {
  type Catalog = {priceList?: {currency?: string; parent?: {adjustment?: {type?: string; value?: number | string} | null} | null} | null};
  const d = await admin<{markets: {nodes: Array<{handle: string; catalogs: {nodes: Catalog[]}}>}}>(
    '{markets(first:50){nodes{handle catalogs(first:5){nodes{... on MarketCatalog{priceList{currency parent{adjustment{type value}}}}}}}}}',
  );
  const m = d.markets.nodes.find((x) => x.handle === INTERNATIONAL_HANDLE);
  if (!m) return 'no International market';
  for (const c of m.catalogs.nodes) {
    const adj = c.priceList?.parent?.adjustment ?? {};
    if (c.priceList?.currency === 'EUR' && adj.type === 'PERCENTAGE_DECREASE' && Math.abs(Number(adj.value ?? 0) - BASE_DECREASE_PCT) <= BASE_DECREASE_TOLERANCE) return null;
  }
  return `International market has no -${BASE_DECREASE_PCT}% base-price list: non-EU retailers pay 75% of a VAT-inclusive price`;
}

/** null when every market keeps a constant tax-inclusive price, else the reason (wholesale_lib.tax_pricing_problem). */
export async function taxPricingProblem(admin: Admin): Promise<string | null> {
  const d = await admin<{shop: {taxesIncluded: boolean}; markets: {nodes: Array<{name: string; priceInclusions?: {inclusiveTaxPricingStrategy?: string | null} | null}>}}>(
    '{shop{taxesIncluded} markets(first:50){nodes{name priceInclusions{inclusiveTaxPricingStrategy}}}}',
  );
  if (!d.shop.taxesIncluded) return 'shop prices exclude tax';
  for (const m of d.markets.nodes) {
    const strategy = m.priceInclusions?.inclusiveTaxPricingStrategy ?? null;
    if (strategy !== null && strategy !== 'INCLUDES_TAXES_IN_PRICE') return `market ${m.name} uses ${strategy}`;
  }
  return null;
}

function codeInput(title: string, code: string, pct: number, variantIds: string[], customerIds: string[], startsAt: string) {
  // endsAt null: a slot deactivated earlier runs again without an end once reused.
  return {
    title, code, startsAt, endsAt: null, appliesOncePerCustomer: false,
    context: {customers: {add: customerIds}} as Record<string, unknown>,
    customerGets: {value: {percentage: pct}, items: {products: {productVariantsToAdd: variantIds} as Record<string, unknown>}},
    combinesWith: {productDiscounts: true, orderDiscounts: false, shippingDiscounts: true},
  };
}

export async function applySlot(
  admin: Admin, action: SlotAction, existing: ExistingCode | null, title: string, code: string,
  want: Group | null, customerIds: string[], startsAt: string,
): Promise<void> {
  const ids = want ? want.variants.map((v) => v.id).sort() : [];
  if (action === 'create' && want) {
    const r = await admin<{discountCodeBasicCreate: {userErrors: Array<{message: string}>}}>(
      'mutation($i:DiscountCodeBasicInput!){discountCodeBasicCreate(basicCodeDiscount:$i){codeDiscountNode{id} userErrors{field message}}}',
      {i: codeInput(title, code, want.pct, ids, customerIds, startsAt)},
    );
    userErrors(r.discountCodeBasicCreate);
  } else if (action === 'update' && want && existing) {
    const {code: _code, ...input} = codeInput(title, code, want.pct, ids, customerIds, startsAt);
    input.customerGets.items.products.productVariantsToRemove = existing.variants.filter((v) => !ids.includes(v));
    input.context = {customers: {
      add: customerIds.filter((c) => !existing.customers.includes(c)),
      remove: existing.customers.filter((c) => !customerIds.includes(c)),
    }};
    const r = await admin<{discountCodeBasicUpdate: {userErrors: Array<{message: string}>}}>(
      'mutation($id:ID!,$i:DiscountCodeBasicInput!){discountCodeBasicUpdate(id:$id,basicCodeDiscount:$i){codeDiscountNode{id} userErrors{field message}}}',
      {id: existing.id, i: input},
    );
    userErrors(r.discountCodeBasicUpdate);
    if (existing.status !== 'ACTIVE') {
      const now = await admin<{codeDiscountNodeByCode: {codeDiscount: {status?: string}} | null}>(
        'query($c:String!){codeDiscountNodeByCode(code:$c){codeDiscount{... on DiscountCodeBasic{status}}}}',
        {c: code},
      );
      if (now.codeDiscountNodeByCode?.codeDiscount.status !== 'ACTIVE') {
        const a = await admin<{discountCodeActivate: {userErrors: Array<{message: string}>}}>(
          'mutation($id:ID!){discountCodeActivate(id:$id){userErrors{field message}}}',
          {id: existing.id},
        );
        userErrors(a.discountCodeActivate);
      }
    }
  } else if (action === 'deactivate' && existing) {
    const r = await admin<{discountCodeDeactivate: {userErrors: Array<{message: string}>}}>(
      'mutation($id:ID!){discountCodeDeactivate(id:$id){userErrors{field message}}}',
      {id: existing.id},
    );
    userErrors(r.discountCodeDeactivate);
  }
}

export type SlotPlan = {code: string; action: Exclude<SlotAction, 'none'>; main: string; slot: number; want: Group | null; existing: ExistingCode | null; customers: string[]};

export type WholesalePlan = {retailers: number; slots: SlotPlan[]; unfit: Array<{main: string; reason: string}>};

/** Read the codes, customers and market prices, and plan every retailer's slots. */
export async function planWholesale(admin: Admin): Promise<WholesalePlan> {
  const codes = await wholesaleCodes(admin);
  const mains = new Map<string, number>();
  for (const code of codes.keys()) {
    const m = CODE_RE.exec(code)!;
    mains.set(m[1], Number(m[2]));
  }
  const owners = [...new Set([...mains.keys()].map((m) => codes.get(m)?.customers[0]).filter((c): c is string => Boolean(c)))];
  const facts = await customers(admin, owners);
  const byCountry = new Map<string | null, LiveVariant[]>();
  const slots: SlotPlan[] = [];
  const unfit: WholesalePlan['unfit'] = [];
  let retailers = 0;
  for (const main of [...mains.keys()].sort()) {
    const rate = mains.get(main)!;
    const first = codes.get(main);
    if (!first || !first.customers.length) continue; // main code missing or without customer
    const customer = facts.get(first.customers[0]) ?? {};
    let div: number;
    try {
      div = customerDivisor(customer);
    } catch (e) {
      unfit.push({main, reason: e instanceof Error ? e.message : 'no divisor'});
      continue;
    }
    const country = customerCountry(customer);
    if (!byCountry.has(country)) byCountry.set(country, await liveVariants(admin, country));
    let gs: Group[];
    try {
      gs = groups(byCountry.get(country)!, rate, div);
    } catch (e) {
      unfit.push({main, reason: e instanceof Error ? e.message : 'groups do not fit'});
      continue;
    }
    retailers++;
    for (let n = 1; n <= GROUPS; n++) {
      const code = slotCode(main, n);
      const want = n <= gs.length ? gs[n - 1] : null;
      const existing = codes.get(code) ?? null;
      const action = planSlot(existing, want, first.customers);
      if (action !== 'none') slots.push({code, action, main, slot: n, want, existing, customers: first.customers});
    }
  }
  return {retailers, slots, unfit};
}

export type WholesaleSyncResult = {
  applied: boolean;
  retailers: number;
  /** Slots that differed from the live price groups (written when applied). */
  drift: number;
  /** Slots still differing on the read back after writing (0 when not applied). */
  left: number;
  unfit: number;
};

/**
 * Plan every retailer's slots and, when writes are enabled, write them and
 * read back. Throws on a Shopify error; callers catch (never break a webhook
 * or a price step).
 */
export async function syncWholesale(
  env: WholesaleEnv,
  {fetcher = fetch, now = new Date()}: {fetcher?: typeof fetch; now?: Date} = {},
): Promise<WholesaleSyncResult> {
  const admin = adminClient(env, fetcher);
  const plan = await planWholesale(admin);
  const apply = wholesaleWritesEnabled(env);
  const result: WholesaleSyncResult = {applied: false, retailers: plan.retailers, drift: plan.slots.length, left: 0, unfit: plan.unfit.length};
  if (plan.unfit.length) console.warn('[wholesale] retailers skipped, prices do not fit the codes', JSON.stringify(plan.unfit.map((u) => u.main)));
  if (!plan.slots.length) return result;
  const summary = plan.slots.map((s) => `${s.code}:${s.action}${s.want ? `@${s.want.pct}` : ''}`);
  if (!apply) {
    console.warn('[wholesale] dry run, slots differ from the live price groups', JSON.stringify(summary));
    return result;
  }
  const startsAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const s of plan.slots) {
    await applySlot(admin, s.action, s.existing, `Wholesale ${s.main} G${s.slot}`, s.code, s.want, s.customers, startsAt);
  }
  const after = await planWholesale(admin);
  result.applied = true;
  result.left = after.slots.length;
  console.warn('[wholesale] slots re-pointed', JSON.stringify(summary), after.slots.length ? `read back: ${after.slots.length} still differ` : 'read back OK');
  return result;
}

/** Status line for /api/status/campaign: counts only. */
export function wholesaleDetail(r: WholesaleSyncResult): string {
  return `${r.applied ? 'applied' : 'dry run'}: ${r.retailers} retailer(s), ${r.drift} slot(s) differed${r.applied ? `, ${r.left} left` : ''}${r.unfit ? `, ${r.unfit} skipped` : ''}`;
}

/** An hourly catch-up: the first five-minute run of each hour. */
export function wholesaleCatchUpDue(scheduledTime: number | undefined): boolean {
  return scheduledTime !== undefined && new Date(scheduledTime).getUTCMinutes() < 5;
}

/**
 * syncWholesale for the background callers: never throws, records the
 * outcome for /api/status/campaign (counts only) and returns null on failure.
 */
export async function runWholesaleSync(
  env: WholesaleEnv,
  {fetcher = fetch, reason}: {fetcher?: typeof fetch; reason: 'price step' | 'hourly'},
): Promise<WholesaleSyncResult | null> {
  if (!wholesaleConfigured(env)) return null;
  try {
    const result = await syncWholesale(env, {fetcher});
    recordOps('wholesaleSync', result.left
      ? {error: `${reason}: ${result.left} slot(s) still differ after writing`}
      : {detail: `${reason}, ${wholesaleDetail(result)}`});
    return result;
  } catch (error) {
    recordOps('wholesaleSync', {error});
    console.warn('[wholesale] sync failed', error instanceof Error ? error.message.slice(0, 200) : 'error');
    return null;
  }
}
