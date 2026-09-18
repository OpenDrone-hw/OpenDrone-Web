import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_FUNDING_OVERLAY,
  mergeFundingOverlay,
  parseFundingOverlay,
} from './funding-overlay.ts';
import {parseCatalog, type Catalog, type CatalogFunding} from './catalog.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/funding-overlay.test.ts

function funding(overrides: Partial<CatalogFunding> = {}): CatalogFunding {
  return {
    targetUnits: 500,
    unitsFunded: 312,
    pct: 62.4,
    state: 'open',
    dateDeadline: '2026-12-01',
    ...overrides,
  };
}

function catalogWith(
  products: Array<{handle: string; funding?: CatalogFunding | null}>,
): Catalog {
  return parseCatalog({
    schema: 1,
    generated_at: '2026-09-15T00:00:00Z',
    max_age: 300,
    currency: 'EUR',
    prices_include_vat: true,
    shop_url: 'https://shop.incutec.com',
    cart_url: 'https://shop.incutec.com/shop/cart',
    add_url: 'https://shop.incutec.com/incutec/add',
    products: products.map((p) => ({
      handle: p.handle,
      title: p.handle,
      family: null,
      description: null,
      url: `https://shop.incutec.com/shop/${p.handle}`,
      images: [],
      rating: null,
      variants: [],
      // funding here is already the parsed (camelCase) shape; smuggle it
      // through parseCatalog's snake_case normalizer via the raw wire shape.
      funding: p.funding
        ? {
            target_units: p.funding.targetUnits,
            units_funded: p.funding.unitsFunded,
            pct: p.funding.pct,
            state: p.funding.state,
            date_deadline: p.funding.dateDeadline,
            // Schema 2 additions ride through the same normalizer; a
            // fixture that sets none of them still parses as schema 1.
            date_open: p.funding.dateOpen ?? null,
            backers: p.funding.backers ?? null,
            amount_funded: p.funding.amountFunded ?? null,
            currency: p.funding.currency ?? null,
          }
        : null,
    })),
  });
}

describe('parseFundingOverlay', () => {
  it('accepts the contract document', () => {
    const overlay = parseFundingOverlay({
      schema: 1,
      updated_at: '2026-09-18T12:00:00Z',
      max_age: 60,
      funding: {
        openrx: {units_funded: 340, pct: 68, state: 'open'},
        openfc: {units_funded: 500, pct: 100, state: 'funded'},
      },
    });
    assert.equal(overlay.updatedAt, '2026-09-18T12:00:00Z');
    // Schema 1 in, schema-2 shape out: the added fields read null rather
    // than being absent, so one reader handles both wire schemas.
    assert.deepEqual(overlay.funding.openrx.unitsFunded, 340);
    assert.deepEqual(overlay.funding.openrx.state, 'open');
    assert.deepEqual(overlay.funding.openfc.unitsFunded, 500);
    assert.deepEqual(overlay.funding.openfc.state, 'funded');
    assert.deepEqual(overlay.funding.openrx.backers, null);
  });

  it('is empty for non-object input', () => {
    assert.deepEqual(parseFundingOverlay(null), EMPTY_FUNDING_OVERLAY);
    assert.deepEqual(parseFundingOverlay(undefined), EMPTY_FUNDING_OVERLAY);
    assert.deepEqual(parseFundingOverlay('<html>down</html>'), EMPTY_FUNDING_OVERLAY);
    assert.deepEqual(parseFundingOverlay(42), EMPTY_FUNDING_OVERLAY);
    assert.deepEqual(parseFundingOverlay([]), EMPTY_FUNDING_OVERLAY);
  });

  it('is empty when the funding map is missing or malformed', () => {
    assert.deepEqual(parseFundingOverlay({}), EMPTY_FUNDING_OVERLAY);
    assert.deepEqual(parseFundingOverlay({funding: null}), EMPTY_FUNDING_OVERLAY);
    assert.deepEqual(parseFundingOverlay({funding: 'nope'}), EMPTY_FUNDING_OVERLAY);
  });

  it('drops one bad entry without failing the rest', () => {
    const overlay = parseFundingOverlay({
      funding: {
        openrx: {units_funded: 340, pct: 68, state: 'open'},
        // unknown state
        openfc: {units_funded: 10, pct: 5, state: 'launched'},
        // non-finite / negative numbers
        openesc: {units_funded: Number.NaN, pct: 5, state: 'open'},
        openframe: {units_funded: -1, pct: 5, state: 'open'},
        openrx2: {units_funded: 10, pct: Number.NaN, state: 'open'},
        openrx3: {units_funded: 10, pct: -1, state: 'open'},
        // not an object
        openrx4: 'nope',
      },
    });
    assert.deepEqual(Object.keys(overlay.funding), ['openrx']);
    assert.equal(overlay.funding.openrx.unitsFunded, 340);
    assert.equal(overlay.funding.openrx.state, 'open');
  });

  it('never throws', () => {
    assert.doesNotThrow(() => parseFundingOverlay(null));
    assert.doesNotThrow(() => parseFundingOverlay({funding: {a: {}}}));
    assert.doesNotThrow(() => parseFundingOverlay({funding: {a: null}}));
  });
});

describe('mergeFundingOverlay', () => {
  it('overlays unitsFunded and state onto a product the catalog already funds', () => {
    const catalog = catalogWith([
      {handle: 'openrx', funding: funding({unitsFunded: 312, state: 'open'})},
    ]);
    const merged = mergeFundingOverlay(catalog, {
      updatedAt: null,
      funding: {openrx: {unitsFunded: 400, state: 'funded'}},
    });
    const product = merged.products.find((p) => p.handle === 'openrx')!;
    assert.equal(product.funding?.unitsFunded, 400);
    assert.equal(product.funding?.state, 'funded');
    // Everything else (target, deadline, pct) passes through untouched.
    assert.equal(product.funding?.targetUnits, 500);
    assert.equal(product.funding?.dateDeadline, '2026-12-01');
  });

  it('never creates a campaign on a product the catalog gave none', () => {
    const catalog = catalogWith([{handle: 'openrx', funding: null}]);
    const merged = mergeFundingOverlay(catalog, {
      updatedAt: null,
      funding: {openrx: {unitsFunded: 400, state: 'funded'}},
    });
    assert.equal(merged.products[0].funding, null);
  });

  it('never resurrects a draft or cancelled campaign', () => {
    const catalog = catalogWith([
      {handle: 'draft-product', funding: funding({state: 'draft'})},
      {handle: 'cancelled-product', funding: funding({state: 'cancelled'})},
    ]);
    const merged = mergeFundingOverlay(catalog, {
      updatedAt: null,
      funding: {
        'draft-product': {unitsFunded: 400, state: 'open'},
        'cancelled-product': {unitsFunded: 400, state: 'open'},
      },
    });
    assert.equal(merged.products[0].funding?.state, 'draft');
    assert.equal(merged.products[0].funding?.unitsFunded, 312);
    assert.equal(merged.products[1].funding?.state, 'cancelled');
    assert.equal(merged.products[1].funding?.unitsFunded, 312);
  });

  it('leaves a product untouched when the overlay carries no entry for it', () => {
    const catalog = catalogWith([
      {handle: 'openrx', funding: funding({unitsFunded: 312})},
    ]);
    const merged = mergeFundingOverlay(catalog, EMPTY_FUNDING_OVERLAY);
    assert.equal(merged.products[0].funding?.unitsFunded, 312);
    // Same object identity: an empty overlay is a true no-op.
    assert.equal(merged, catalog);
  });

  it('is a pure function: the input catalog is never mutated', () => {
    const catalog = catalogWith([
      {handle: 'openrx', funding: funding({unitsFunded: 312})},
    ]);
    const before = JSON.stringify(catalog);
    mergeFundingOverlay(catalog, {
      updatedAt: null,
      funding: {openrx: {unitsFunded: 999, state: 'funded'}},
    });
    assert.equal(JSON.stringify(catalog), before);
  });
});

describe('parseFundingOverlay, schema 2', () => {
  it('carries the added fields when the feed has them', () => {
    const overlay = parseFundingOverlay({
      schema: 2,
      updated_at: '2026-09-18T12:00:00Z',
      max_age: 60,
      funding: {
        openrx: {
          units_funded: 340,
          pct: 68,
          state: 'open',
          target_units: 500,
          date_open: '2026-09-01',
          date_deadline: '2026-12-01',
          backers: 288,
          amount_funded: 10880.5,
          currency: 'EUR',
        },
      },
    });
    assert.deepEqual(overlay.funding.openrx, {
      unitsFunded: 340,
      state: 'open',
      targetUnits: 500,
      dateOpen: '2026-09-01',
      dateDeadline: '2026-12-01',
      backers: 288,
      amountFunded: 10880.5,
      currency: 'EUR',
    });
  });

  it('reads a schema-1 entry as the same shape with nulls', () => {
    // The schema number itself is never read: an entry is accepted on the
    // three fields every schema carries, so an old feed keeps working and
    // a new one reaching an old build is still readable.
    const overlay = parseFundingOverlay({
      schema: 1,
      funding: {openrx: {units_funded: 340, pct: 68, state: 'open'}},
    });
    assert.deepEqual(overlay.funding.openrx, {
      unitsFunded: 340,
      state: 'open',
      targetUnits: null,
      dateOpen: null,
      dateDeadline: null,
      backers: null,
      amountFunded: null,
      currency: null,
    });
  });

  it('drops one malformed added field without losing the entry', () => {
    const overlay = parseFundingOverlay({
      schema: 2,
      funding: {
        openrx: {
          units_funded: 340,
          pct: 68,
          state: 'open',
          // Zero is not a target, NaN is not a count, an empty string is
          // not a currency: each is dropped on its own.
          target_units: 0,
          backers: Number.NaN,
          amount_funded: -5,
          currency: '',
          date_deadline: 42,
        },
      },
    });
    assert.equal(overlay.funding.openrx.unitsFunded, 340);
    assert.equal(overlay.funding.openrx.targetUnits, null);
    assert.equal(overlay.funding.openrx.backers, null);
    assert.equal(overlay.funding.openrx.amountFunded, null);
    assert.equal(overlay.funding.openrx.currency, null);
    assert.equal(overlay.funding.openrx.dateDeadline, null);
  });
});

describe('mergeFundingOverlay, schema 2 fields', () => {
  it('carries the added fields onto the catalog campaign', () => {
    const catalog = catalogWith([{handle: 'openrx', funding: funding()}]);
    const merged = mergeFundingOverlay(catalog, {
      updatedAt: null,
      funding: {
        openrx: {
          unitsFunded: 400,
          state: 'open',
          targetUnits: 600,
          dateOpen: '2026-09-01',
          dateDeadline: '2027-01-15',
          backers: 355,
          amountFunded: 12800,
          currency: 'EUR',
        },
      },
    });
    const live = merged.products[0].funding!;
    assert.equal(live.unitsFunded, 400);
    assert.equal(live.targetUnits, 600);
    assert.equal(live.dateOpen, '2026-09-01');
    assert.equal(live.dateDeadline, '2027-01-15');
    assert.equal(live.backers, 355);
    assert.equal(live.amountFunded, 12800);
    assert.equal(live.currency, 'EUR');
  });

  it('never blanks a catalog value the overlay does not carry', () => {
    // A schema-1 feed must leave a schema-2 catalog alone apart from the
    // two live fields it exists to refresh.
    const catalog = catalogWith([
      {
        handle: 'openrx',
        funding: {...funding(), backers: 288, amountFunded: 9000, currency: 'EUR'},
      },
    ]);
    const merged = mergeFundingOverlay(catalog, {
      updatedAt: null,
      funding: {openrx: {unitsFunded: 400, state: 'open'}},
    });
    const live = merged.products[0].funding!;
    assert.equal(live.unitsFunded, 400);
    assert.equal(live.backers, 288);
    assert.equal(live.amountFunded, 9000);
    assert.equal(live.currency, 'EUR');
    assert.equal(live.targetUnits, 500);
    assert.equal(live.dateDeadline, '2026-12-01');
  });
});
