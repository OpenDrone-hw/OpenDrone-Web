import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {opsStatus, resetOpsStatus} from './preorder-ops-status.ts';
import {
  EU_VAT, EXEMPTION, GROUPS, GroupsDoNotFit, MAX_UNIT_DEVIATION, customerCountry, customerDivisor, divisor, groups,
  label, planSlot, pyRound, runWholesaleSync, syncWholesale, toLiveVariants, unitDeviation, wholesaleCatchUpDue, wholesaleWritesEnabled,
  worstUnitCents, type ExistingCode, type LiveVariant,
} from './wholesale-sync.ts';

// Same fixtures as scripts/test_wholesale_lib.py.
const V: LiveVariant[] = [
  {id: 'a', sku: 'FC', title: '', price: 35.10, retail: 39.0}, // 10% step
  {id: 'b', sku: 'RX', title: '', price: 16.80, retail: 21.0}, // 20% step
  {id: 'c', sku: 'AT', title: '', price: 39.0, retail: 39.0}, // at retail
];

const INTL: Array<[string, string, number, number]> = [
  ['OPENESC-2020', 'Buy now', 40.5, 40.5], ['OPENESC-2020', 'Pre-order', 36.5, 40.5],
  ['OPENESC-3030', 'Buy now', 48.9, 48.9], ['OPENESC-3030', 'Pre-order', 43.9, 48.9],
  ['OPENFC-LITE-2020', 'Buy now', 24.0, 24.0], ['OPENFC-LITE-2020', 'Pre-order', 21.5, 24.0],
  ['OPENFC-LITE-3030', 'Buy now', 32.0, 32.0], ['OPENFC-LITE-3030', 'Pre-order', 29.0, 32.0],
  ['OPENFRAME-3', '3in', 29.0, 32.0], ['OPENFRAME-5', '5in', 36.5, 40.5],
  ['OPENMOTOR-1604', '6S', 14.0, 15.9], ['OPENMOTOR-1604-4S', '4S', 14.0, 15.9],
  ['OPENMOTOR-2306', '6S', 17.9, 19.9], ['OPENMOTOR-2306-4S', '4S', 15.9, 19.9],
  ['OPENRX-GEMINI', 'Gemini', 23.9, 29.9], ['OPENRX-LITE', 'Lite', 13.9, 17.5],
  ['OPENRX-LITE-UFL', 'Lite-UFL', 15.5, 17.5], ['OPENRX-MONO', 'Mono', 20.0, 22.5],
];
const INTL_V: LiveVariant[] = INTL.map(([sku, title, price, retail], i) => ({id: `v${i}`, sku, title, price, retail}));

const paid = (v: LiveVariant, pct: number) => pyRound(v.price - pyRound(v.price * pct + 1e-9, 2), 2);
const show = (gs: ReturnType<typeof groups>) => gs.map((g) => [g.pct, g.variants.map((v) => v.id)]);

describe('price maths (parity with scripts/wholesale_lib.py)', () => {
  it('gross groups land on 75% of retail, with the Python percentages', () => {
    const gs = groups(V, 25);
    assert.deepEqual(show(gs), [[0.0625, ['b']], [0.1667, ['a']], [0.25, ['c']]]);
    for (const g of gs) for (const v of g.variants) assert.ok(Math.abs(v.price * (1 - g.pct) - 0.75 * v.retail) < 0.005);
  });

  it('retail 39.00 at the 10% step (35.10) gets 0.1667', () => {
    assert.equal(groups([V[0]], 25)[0].pct, 0.1667);
  });

  it('reverse charge lands on net 75%: ES 39 x 0.75 / 1.21 = 24.17', () => {
    const d = divisor('ES', true);
    assert.equal(d, 1.21);
    const gs = groups(V, 25, d);
    assert.deepEqual(show(gs), [[0.2252, ['b']], [0.3113, ['a']], [0.3802, ['c']]]);
    const fc = gs.find((g) => g.variants.some((v) => v.sku === 'FC'))!;
    assert.equal(paid(V[0], fc.pct), 24.17);
  });

  it('a non-EU retailer pays 75% of its market base price', () => {
    const intl = V.map((v) => ({...v, price: pyRound(v.price / 1.21, 2), retail: pyRound(v.retail / 1.21, 2)}));
    for (const g of groups(intl, 25, divisor('CH', false))) {
      for (const v of g.variants) {
        assert.ok(Math.abs(paid(v, g.pct) - pyRound(0.75 * v.retail, 2)) <= 0.011);
        assert.ok(paid(v, g.pct) < 0.75 * v.retail * 1.21 - 0.5);
      }
    }
  });

  it('not exempt stays gross; exempt outside the EU is refused', () => {
    assert.equal(divisor('ES', false), 1);
    assert.equal(divisor('AU', false), 1);
    assert.throws(() => divisor('AU', true));
  });

  it('customer country and divisor', () => {
    const c = {tags: ['wholesale'], taxExemptions: [EXEMPTION], note: '2026-10-29 VAT ESY3837488K VIES valid'};
    assert.equal(customerCountry(c), 'ES');
    assert.equal(customerDivisor(c), 1.21);
    assert.equal(customerCountry({tags: ['country-de'], note: ''}), 'DE');
    assert.equal(customerCountry({tags: [], note: 'VAT EL123456789 VIES valid'}), 'GR');
    assert.equal(customerCountry({tags: ['wholesale', 'country-ch'], note: ''}), 'CH');
    assert.equal(customerCountry({tags: ['wholesale'], note: ''}), null);
    assert.equal(customerDivisor({tags: ['wholesale'], taxExemptions: [], note: ''}), 1);
  });

  it('every EU state has a rate', () => {
    assert.equal(Object.keys(EU_VAT).length, 27);
  });

  it('fixed market prices cluster into four codes exactly as Python does', () => {
    const gs = groups(INTL_V, 25);
    assert.ok(gs.length <= GROUPS);
    assert.deepEqual(show(gs), [
      [0.1644, ['v10', 'v11', 'v16', 'v17', 'v5', 'v3']],
      [0.1721, ['v12', 'v1', 'v9', 'v7', 'v8']],
      [0.25, ['v0', 'v2', 'v4', 'v6']],
      [0.0613, ['v15', 'v13', 'v14']],
    ]);
    for (const g of gs) {
      for (const v of g.variants) {
        const off = unitDeviation(v, g.pct, 25);
        assert.ok(off <= 0.015, v.sku);
        assert.ok(Math.abs(off) <= MAX_UNIT_DEVIATION * v.price);
      }
    }
    assert.ok(Math.abs(worstUnitCents(gs, 25) - 22.5) < 1e-6);
  });

  it('prices that cannot fit four codes throw', () => {
    const spread = Array.from({length: 9}, (_, i) => ({id: String(i), sku: `S${i}`, title: '', price: 10, retail: 10 + 0.4 * i}));
    assert.throws(() => groups(spread, 25), GroupsDoNotFit);
  });

  it('both lanes of one SKU each land on 75%', () => {
    const lanes: LiveVariant[] = [
      {id: 'pre', sku: 'OPENFC-LITE-2020', title: '20x20 / Pre-order', price: 26.10, retail: 29},
      {id: 'now', sku: 'OPENFC-LITE-2020', title: '20x20 / Buy now', price: 29, retail: 29},
      {id: 'pre30', sku: 'OPENFC-LITE-3030', title: '30x30 / Pre-order', price: 39, retail: 39},
    ];
    const gs = groups(lanes, 25);
    assert.deepEqual(show(gs), [[0.25, ['now', 'pre30']], [0.1667, ['pre']]]);
    for (const g of gs) for (const v of g.variants) assert.equal(paid(v, g.pct), pyRound(0.75 * v.retail, 2));
    assert.equal(label(lanes[1]), 'OPENFC-LITE-2020 (20x20 / Buy now)');
  });

  it('pyRound rounds an exact half to even like Python', () => {
    assert.equal(pyRound(0.125, 2), 0.12);
    assert.equal(pyRound(0.375, 2), 0.38);
    assert.equal(pyRound(0.16666, 4), 0.1667);
  });
});

describe('live variants', () => {
  it('a variant at the retail step keeps its price as retail; archived products are left out; market prices win', () => {
    const got = toLiveVariants([
      {id: 'a', sku: 'OPENFC-LITE-3030', price: '39.00', compareAtPrice: null, product: {status: 'ACTIVE'}},
      {id: 'b', sku: 'OPENFC-LITE-2020', price: '26.10', compareAtPrice: '29.00', product: {status: 'ACTIVE'}},
      {id: 'c', sku: 'OPENOLD', price: '9.00', compareAtPrice: null, product: {status: 'ARCHIVED'}},
    ], null);
    assert.deepEqual(got.map((v) => [v.sku, v.retail]), [['OPENFC-LITE-2020', 29], ['OPENFC-LITE-3030', 39]]);
    const ch = toLiveVariants([{id: 'b', sku: 'OPENFC-LITE-2020', title: 'Pre-order', price: '26.10', compareAtPrice: '29.00',
      product: {status: 'ACTIVE'}, ctx: {price: {amount: '21.57'}, compareAtPrice: {amount: '23.97'}}}], 'CH');
    assert.deepEqual([ch[0].price, ch[0].retail], [21.57, 23.97]);
  });
});

describe('slot plan', () => {
  const want = {pct: 0.25, variants: [{id: 'now', sku: 'X', title: '', price: 29, retail: 29}]};
  const code = (over: Partial<ExistingCode>): ExistingCode =>
    ({id: 'gid://d/1', code: 'WS25-X', status: 'ACTIVE', customers: ['c'], pct: 0.25, variants: ['now'], ...over});
  it('matches, updates, creates and deactivates', () => {
    assert.equal(planSlot(code({}), want, ['c']), 'none');
    assert.equal(planSlot(code({pct: 0.1667}), want, ['c']), 'update');
    assert.equal(planSlot(code({status: 'EXPIRED'}), want, ['c']), 'update');
    assert.equal(planSlot(code({variants: ['old']}), want, ['c']), 'update');
    assert.equal(planSlot(null, want, ['c']), 'create');
    assert.equal(planSlot(code({}), null, ['c']), 'deactivate');
    assert.equal(planSlot(code({status: 'EXPIRED'}), null, ['c']), 'none');
    assert.equal(planSlot(null, null, ['c']), 'none');
  });
});

describe('switches', () => {
  it('writes only with "1" and never on staging', () => {
    assert.equal(wholesaleWritesEnabled({}), false);
    assert.equal(wholesaleWritesEnabled({WHOLESALE_SYNC_WRITE_ENABLED: '0'}), false);
    assert.equal(wholesaleWritesEnabled({WHOLESALE_SYNC_WRITE_ENABLED: '1'}), true);
    assert.equal(wholesaleWritesEnabled({WHOLESALE_SYNC_WRITE_ENABLED: '1', STAGING_PASSWORD: 'x'}), false);
  });
  it('the hourly catch-up is the first five-minute run of the hour', () => {
    assert.equal(wholesaleCatchUpDue(Date.UTC(2026, 10, 23, 14, 0)), true);
    assert.equal(wholesaleCatchUpDue(Date.UTC(2026, 10, 23, 14, 5)), false);
    assert.equal(wholesaleCatchUpDue(undefined), false);
  });
});

/** Admin API double: wholesale codes, one customer, the variants; records every mutation. */
function shop({codes, customer}: {codes: Array<{code: string; status: string; pct: number; variants: string[]}>; customer: Record<string, unknown>}) {
  const mutations: Array<{query: string; variables: Record<string, unknown>}> = [];
  const state = codes.map((c, i) => ({...c, id: `gid://shopify/DiscountCodeNode/${i}`}));
  const variants = [
    {id: 'gid://v/a', sku: 'OPENFC-LITE-3030', title: 'Pre-order', price: '35.10', compareAtPrice: '39.00', product: {status: 'ACTIVE'}},
    {id: 'gid://v/b', sku: 'OPENRX-LITE', title: '', price: '16.80', compareAtPrice: '21.00', product: {status: 'ACTIVE'}},
    {id: 'gid://v/c', sku: 'OPENFC-LITE-3030', title: 'Buy now', price: '39.00', compareAtPrice: null, product: {status: 'ACTIVE'}},
  ];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {query: string; variables: Record<string, unknown>};
    const json = (data: unknown) => new Response(JSON.stringify({data}));
    if (body.query.startsWith('mutation')) {
      mutations.push(body);
      const input = body.variables.i as {customerGets?: {value: {percentage: number}; items: {products: {productVariantsToAdd: string[]}}}};
      const target = state.find((c) => c.id === body.variables.id);
      if (target && input?.customerGets) {
        target.pct = input.customerGets.value.percentage;
        target.variants = input.customerGets.items.products.productVariantsToAdd;
        target.status = 'ACTIVE';
      }
      if (target && body.query.includes('discountCodeDeactivate')) target.status = 'EXPIRED';
      if (body.query.includes('discountCodeBasicCreate')) {
        const i = body.variables.i as {code: string; customerGets: {value: {percentage: number}; items: {products: {productVariantsToAdd: string[]}}}};
        state.push({id: `gid://new/${state.length}`, code: i.code, status: 'ACTIVE', pct: i.customerGets.value.percentage, variants: i.customerGets.items.products.productVariantsToAdd});
      }
      const key = /\{(\w+)\(/.exec(body.query)![1];
      return json({[key]: {userErrors: []}});
    }
    if (body.query.includes('codeDiscountNodes')) {
      return json({codeDiscountNodes: {pageInfo: {hasNextPage: false, endCursor: null}, nodes: [
        {id: 'gid://other', codeDiscount: {status: 'ACTIVE', codes: {nodes: [{code: 'WELCOME10'}]}}},
        ...state.map((c) => ({id: c.id, codeDiscount: {status: c.status, codes: {nodes: [{code: c.code}]},
          context: {customers: [{id: 'gid://c/1'}]}, customerGets: {value: {percentage: c.pct}, items: {productVariants: {nodes: c.variants.map((id) => ({id}))}}}}})),
      ]}});
    }
    if (body.query.includes('nodes(ids')) return json({nodes: [{id: 'gid://c/1', ...customer}]});
    if (body.query.includes('productVariants(')) {
      // Market prices: the same as the shop's EUR prices in this double.
      return json({productVariants: {nodes: variants.map((v) => ({...v, ctx: {price: {amount: v.price}, compareAtPrice: v.compareAtPrice ? {amount: v.compareAtPrice} : null}}))}});
    }
    throw new Error(`unexpected query ${body.query.slice(0, 40)}`);
  }) as typeof fetch;
  return {fetcher, mutations, state};
}

const ENV = {SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'token'};

describe('syncWholesale', () => {
  const stale = [
    {code: 'WS25-SHOP', status: 'ACTIVE', pct: 0.1667, variants: ['gid://v/a', 'gid://v/b']}, // drifted
    {code: 'WS25-SHOP-G2', status: 'ACTIVE', pct: 0.25, variants: ['gid://v/c']},
    {code: 'WS25-SHOP-G4', status: 'ACTIVE', pct: 0.1, variants: ['gid://v/b']}, // no group any more
  ];

  it('plans only while the switch is off, and writes nothing', async () => {
    const {fetcher, mutations} = shop({codes: stale, customer: {tags: ['wholesale', 'country-be'], taxExemptions: [], note: ''}});
    const r = await syncWholesale({...ENV, WHOLESALE_SYNC_WRITE_ENABLED: '0'}, {fetcher});
    assert.equal(r.applied, false);
    assert.equal(r.drift, 4); // slots 1 and 2 update, slot 3 create, slot 4 deactivate
    assert.equal(mutations.length, 0);
  });

  it('with the switch on it re-points, creates, deactivates and reads back clean', async () => {
    const {fetcher, mutations, state} = shop({codes: stale, customer: {tags: ['wholesale', 'country-be'], taxExemptions: [], note: ''}});
    const r = await syncWholesale({...ENV, WHOLESALE_SYNC_WRITE_ENABLED: '1'}, {fetcher, now: new Date('2026-11-23T12:00:00Z')});
    assert.deepEqual({applied: r.applied, drift: r.drift, left: r.left}, {applied: true, drift: 4, left: 0});
    assert.deepEqual(mutations.map((m) => /\{(\w+)\(/.exec(m.query)![1]), ['discountCodeBasicUpdate', 'discountCodeBasicUpdate', 'discountCodeBasicCreate', 'discountCodeDeactivate']);
    const update = mutations[0].variables.i as {endsAt: unknown; code?: string; customerGets: {items: {products: {productVariantsToRemove: string[]}}}};
    assert.equal(update.endsAt, null);
    assert.equal(update.code, undefined);
    assert.deepEqual(update.customerGets.items.products.productVariantsToRemove, ['gid://v/a']);
    assert.deepEqual(state.map((c) => [c.code, c.pct, c.status]).sort(), [
      ['WS25-SHOP', 0.0625, 'ACTIVE'], ['WS25-SHOP-G2', 0.1667, 'ACTIVE'], ['WS25-SHOP-G3', 0.25, 'ACTIVE'], ['WS25-SHOP-G4', 0.1, 'EXPIRED'],
    ].sort());
  });

  it('a reverse-charge retailer is priced on net retail', async () => {
    const {fetcher, state} = shop({codes: [stale[0]], customer: {tags: ['wholesale', 'country-es'], taxExemptions: [EXEMPTION], note: ''}});
    await syncWholesale({...ENV, WHOLESALE_SYNC_WRITE_ENABLED: '1'}, {fetcher});
    assert.deepEqual(state.map((c) => [c.code, c.pct]).sort(), [['WS25-SHOP', 0.2252], ['WS25-SHOP-G2', 0.3113], ['WS25-SHOP-G3', 0.3802]].sort());
  });

  it('never writes on staging', async () => {
    const {fetcher, mutations} = shop({codes: stale, customer: {tags: ['country-be'], taxExemptions: [], note: ''}});
    await syncWholesale({...ENV, WHOLESALE_SYNC_WRITE_ENABLED: '1', STAGING_PASSWORD: 'x'}, {fetcher});
    assert.equal(mutations.length, 0);
  });
});

describe('runWholesaleSync', () => {
  it('never throws: a Shopify failure is recorded and returns null', async () => {
    resetOpsStatus();
    const fetcher = (async () => new Response('down', {status: 502})) as unknown as typeof fetch;
    assert.equal(await runWholesaleSync(ENV, {fetcher, reason: 'hourly'}), null);
    assert.equal(opsStatus().wholesaleSync?.last.ok, false);
  });
  it('does nothing without an Admin token', async () => {
    assert.equal(await runWholesaleSync({}, {reason: 'hourly'}), null);
  });
  it('records counts only', async () => {
    resetOpsStatus();
    const {fetcher} = shop({codes: [{code: 'WS25-SHOP', status: 'ACTIVE', pct: 0.0625, variants: ['gid://v/b']}], customer: {tags: ['country-be'], taxExemptions: [], note: ''}});
    await runWholesaleSync(ENV, {fetcher, reason: 'price step'});
    const detail = opsStatus().wholesaleSync?.last.detail ?? '';
    assert.match(detail, /^price step, dry run: 1 retailer\(s\), 2 slot\(s\) differed$/);
    assert.doesNotMatch(detail, /WS25|gid:/);
  });
});
