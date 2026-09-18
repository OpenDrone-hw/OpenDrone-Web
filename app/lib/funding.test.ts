import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  fundingLabel,
  fundingPct,
  fundingStatusText,
  isFundedPreorder,
} from './funding.ts';
import type {CatalogFunding, CatalogProduct} from './catalog.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/funding.test.ts

function funding(overrides: Partial<CatalogFunding> = {}): CatalogFunding {
  return {
    targetUnits: 500,
    unitsFunded: 312,
    pct: 62.4,
    state: 'open',
    dateDeadline: '2026-12-01',
    explainerUrl: 'https://shop.incutec.com/pages/funding',
    ...overrides,
  };
}

describe('fundingPct', () => {
  it('rounds to an integer', () => {
    assert.equal(fundingPct(funding({pct: 62.4})), 62);
    assert.equal(fundingPct(funding({pct: 62.6})), 63);
  });

  it('clamps to 0-100', () => {
    assert.equal(fundingPct(funding({pct: -10})), 0);
    assert.equal(fundingPct(funding({pct: 140})), 100);
  });

  it('is 0 for no funding', () => {
    assert.equal(fundingPct(null), 0);
    assert.equal(fundingPct(undefined), 0);
  });
});

describe('fundingLabel', () => {
  it('reads "X of Y funded"', () => {
    assert.equal(
      fundingLabel(funding({unitsFunded: 312, targetUnits: 500})),
      '312 of 500 funded',
    );
  });

  it('is empty for no funding', () => {
    assert.equal(fundingLabel(null), '');
  });
});

describe('fundingStatusText', () => {
  it('has text for open, funded and missed', () => {
    assert.equal(fundingStatusText(funding({state: 'open'})), 'Funding open');
    assert.equal(fundingStatusText(funding({state: 'funded'})), 'Funded');
    assert.equal(fundingStatusText(funding({state: 'missed'})), 'Funding missed');
  });

  it('is empty for draft, cancelled or no funding', () => {
    assert.equal(fundingStatusText(funding({state: 'draft'})), '');
    assert.equal(fundingStatusText(funding({state: 'cancelled'})), '');
    assert.equal(fundingStatusText(null), '');
  });
});

describe('isFundedPreorder', () => {
  const base: CatalogProduct = {
    handle: 'openrx',
    title: 'OpenRX',
    family: null,
    description: null,
    url: 'https://shop.incutec.com/shop/openrx-40',
    images: [],
    rating: null,
    variants: [],
  };

  it('is true when the product carries a funding object', () => {
    assert.equal(isFundedPreorder({...base, funding: funding()}), true);
  });

  it('is false when funding is null, absent or the product is missing', () => {
    assert.equal(isFundedPreorder({...base, funding: null}), false);
    assert.equal(isFundedPreorder(base), false);
    assert.equal(isFundedPreorder(null), false);
    assert.equal(isFundedPreorder(undefined), false);
  });
});
