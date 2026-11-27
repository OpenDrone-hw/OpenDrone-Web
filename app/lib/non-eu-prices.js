// @ts-nocheck: plain JavaScript shared by scripts/us-prices.mjs (node) and the Worker.
/**
 * Non-EU prices from the EU list price (content/us-sales.json): the US
 * percentage uplift and the fixed International (EUR, without Belgian VAT)
 * and UK (GBP) prices with their endings. Pure functions plus the Shopify
 * documents; `scripts/us-prices.mjs` is the manual run and
 * `syncFixedPrices` the Worker's, after every price step it writes.
 */

const BE_VAT = 0.21;

export const READ_QUERY = `#graphql
  query OpenDroneNonEuPrices($after: String) {
    priceLists(first: 50) {
      nodes { id name currency parent { adjustment { type value } } }
    }
    markets(first: 50) { nodes { handle priceInclusions { inclusiveTaxPricingStrategy } } }
    productVariants(first: 250, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id sku title price compareAtPrice product { status } }
    }
  }
`;

export const FIXED_QUERY = `#graphql
  query OpenDroneNonEuFixed($id: ID!, $after: String) {
    priceList(id: $id) {
      prices(first: 250, after: $after, originType: FIXED) {
        pageInfo { hasNextPage endCursor }
        nodes { variant { id } price { amount currencyCode } compareAtPrice { amount } }
      }
    }
  }
`;

export const FIXED_ADD = `#graphql
  mutation OpenDroneNonEuFixedAdd($id: ID!, $prices: [PriceListPriceInput!]!) {
    priceListFixedPricesAdd(priceListId: $id, prices: $prices) {
      prices { variant { id } price { amount } }
      userErrors { field code message }
    }
  }
`;

export const PRICE_LIST_UPDATE = `#graphql
  mutation OpenDroneUsPriceList($id: ID!, $input: PriceListUpdateInput!) {
    priceListUpdate(id: $id, input: $input) {
      priceList { id name parent { adjustment { type value } } }
      userErrors { field message }
    }
  }
`;

const cents = (n) => Math.round(n * 100 + 1e-6) / 100;

/** The validated rule of content/us-sales.json: the US uplift and the base-price rule. */
export function parseRule(raw) {
  const fail = (m) => {
    throw new Error(`content/us-sales.json: ${m}`);
  };
  const pct = raw.priceUpliftPct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 300) fail('priceUpliftPct must be a number from 0 to 300');
  const b = raw.basePrice ?? {};
  if (!Array.isArray(b.endings) || !b.endings.length || !b.endings.every((e) => e >= 0 && e < 1)) {
    fail('basePrice.endings must be fractions from 0 to below 1');
  }
  if (!(b.intlDecreasePct > 0 && b.intlDecreasePct < 50)) fail('basePrice.intlDecreasePct must be from 0 to 50');
  if (!(b.gbpPerEur > 0.5 && b.gbpPerEur < 2)) fail('basePrice.gbpPerEur must be a rate between 0.5 and 2');
  if (!(b.ukVatPct >= 0 && b.ukVatPct < 30)) fail('basePrice.ukVatPct must be from 0 to 30');
  return {priceUpliftPct: pct, endings: b.endings, intlDecreasePct: b.intlDecreasePct, gbpPerEur: b.gbpPerEur, ukVatPct: b.ukVatPct};
}

/** The name with its "(+N%)" suffix set to `pct`; appended when absent. */
export function nameWithUplift(name, pct) {
  const suffix = `(+${pct}%)`;
  return /\(\+[\d.]+%\)\s*$/.test(name) ? name.replace(/\(\+[\d.]+%\)\s*$/, suffix) : `${name} ${suffix}`;
}

/** The USD price list that is a percentage increase on the EUR price. */
export function findUsList(lists) {
  const matches = lists.filter((l) => l.currency === 'USD' && l.parent?.adjustment?.type === 'PERCENTAGE_INCREASE');
  if (matches.length !== 1) {
    throw new Error(`expected exactly one USD PERCENTAGE_INCREASE price list, found ${matches.length}`);
  }
  return matches[0];
}

/** What the run would change on the US list, or null when Shopify already matches. */
export function planUplift(list, pct) {
  const live = Number(list.parent.adjustment.value);
  const name = nameWithUplift(list.name, pct);
  if (live === pct && name === list.name) return null;
  return {id: list.id, from: live, to: pct, name: {from: list.name, to: name}};
}

/** The nearest price ending (.00, .50, .90 by default); a tie goes to the higher price. */
export function withEnding(x, endings) {
  const whole = Math.trunc(x);
  let best = null;
  for (const w of [whole - 1, whole, whole + 1]) {
    for (const e of endings) {
      const c = w + e;
      if (c <= 0) continue;
      if (best === null || Math.abs(c - x) < Math.abs(best - x) || (Math.abs(c - x) === Math.abs(best - x) && c > best)) best = c;
    }
  }
  return cents(best);
}

/** The International EUR price of a EUR VAT-inclusive list price: the base with an ending. */
export function intlPrice(eurList, rule) {
  return withEnding(eurList / (1 + BE_VAT), rule.endings);
}

/** The UK GBP price, UK VAT inside: base x gbpPerEur x (1 + ukVatPct), with an ending. */
export function ukPrice(eurList, rule) {
  return withEnding((eurList / (1 + BE_VAT)) * rule.gbpPerEur * (1 + rule.ukVatPct / 100), rule.endings);
}

/** The International base-price list (EUR, -intlDecreasePct %) and the UK list (GBP), when they exist. */
export function findOtherLists(lists, rule) {
  const intl = lists.filter(
    (l) => l.currency === 'EUR' && l.parent?.adjustment?.type === 'PERCENTAGE_DECREASE' && Math.abs(l.parent.adjustment.value - rule.intlDecreasePct) <= 0.01,
  );
  const uk = lists.filter((l) => l.currency === 'GBP' && l.parent?.adjustment);
  if (intl.length > 1 || uk.length > 1) throw new Error(`expected at most one International and one GBP price list, found ${intl.length} and ${uk.length}`);
  return {intl: intl[0] ?? null, uk: uk[0] ?? null};
}

/**
 * Fixed prices to write on one list: one per active variant whose live fixed price or
 * compare-at differs from `priceOf(eurList)` (or that has none). `fixed` maps variant id
 * to {price, compareAt}.
 */
export function planFixedBy(variants, fixed, priceOf) {
  const plan = [];
  for (const v of variants) {
    if (v.product?.status !== 'ACTIVE') continue;
    const price = priceOf(Number(v.price));
    const compare = v.compareAtPrice && Number(v.compareAtPrice) > Number(v.price) ? priceOf(Number(v.compareAtPrice)) : null;
    const live = fixed.get(v.id);
    const same = live && cents(live.price) === price && (live.compareAt == null ? compare == null : compare != null && cents(live.compareAt) === compare);
    if (!same) plan.push({id: v.id, sku: v.sku, title: v.title, from: live ?? null, price, compareAt: compare});
  }
  return plan;
}

/** The mutation input of a plan. */
export function fixedInput(plan, currencyCode) {
  return plan.map((p) => ({
    variantId: p.id,
    price: {amount: p.price.toFixed(2), currencyCode},
    // An explicit null clears a stale struck-through price: leaving the field out keeps it.
    compareAtPrice: p.compareAt != null ? {amount: p.compareAt.toFixed(2), currencyCode} : null,
  }));
}

/** Per fixed-price list (International, UK): the plan of fixed prices that differ from the rule. */
export function planAll(variants, lists, rule) {
  return lists.map((l) => ({
    ...l,
    plan: planFixedBy(variants, l.fixed, (eur) => (l.currency === 'GBP' ? ukPrice(eur, rule) : intlPrice(eur, rule))),
  }));
}


/** Read every variant, the price lists and the fixed International and UK prices. */
export async function readFixedLists(admin, rule) {
  const variants = [];
  let after = null;
  let first;
  do {
    const data = await admin(READ_QUERY, {after});
    first ??= data;
    variants.push(...data.productVariants.nodes);
    after = data.productVariants.pageInfo.hasNextPage ? data.productVariants.pageInfo.endCursor : null;
  } while (after);
  const other = findOtherLists(first.priceLists.nodes, rule);
  const fixedOf = async (l) => {
    const fixed = new Map();
    let cursor = null;
    do {
      const page = (await admin(FIXED_QUERY, {id: l.id, after: cursor})).priceList.prices;
      for (const n of page.nodes) {
        fixed.set(n.variant.id, {price: Number(n.price.amount), compareAt: n.compareAtPrice ? Number(n.compareAtPrice.amount) : null});
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return fixed;
  };
  const lists = [];
  if (other.intl) lists.push({name: 'International', list: other.intl, currency: 'EUR', fixed: await fixedOf(other.intl)});
  if (other.uk) lists.push({name: 'UK', list: other.uk, currency: 'GBP', fixed: await fixedOf(other.uk)});
  const taxStrategies = Object.fromEntries(first.markets.nodes.map((m) => [m.handle, m.priceInclusions?.inclusiveTaxPricingStrategy ?? null]));
  return {variants, priceLists: first.priceLists.nodes, lists, taxStrategies};
}

/** A market other than Belgium whose prices are not constant tax-inclusive: the base-price rule does not hold. */
export function taxStrategyProblem(taxStrategies) {
  for (const [handle, strategy] of Object.entries(taxStrategies)) {
    if (handle !== 'be' && strategy !== 'INCLUDES_TAXES_IN_PRICE') return `market ${handle} uses ${strategy}`;
  }
  return null;
}

/**
 * Bring the International and UK fixed prices to the rule (the US list is a
 * percentage and follows by itself). Returns the SKUs written. Refuses when
 * a market is not constant tax-inclusive, like the manual run.
 */
export async function syncFixedPrices(admin, rule) {
  const live = await readFixedLists(admin, rule);
  if (!live.lists.length) return [];
  const problem = taxStrategyProblem(live.taxStrategies);
  if (problem) throw new Error(`non-EU prices: ${problem}`);
  const written = [];
  for (const l of planAll(live.variants, live.lists, rule)) {
    if (!l.plan.length) continue;
    const r = (await admin(FIXED_ADD, {id: l.list.id, prices: fixedInput(l.plan, l.currency)})).priceListFixedPricesAdd;
    if (r.userErrors?.length) throw new Error(`${l.name}: ${r.userErrors.map((e) => e.message).join('; ')}`);
    written.push(...l.plan.map((p) => `${l.name} ${p.sku}`));
  }
  return written;
}
