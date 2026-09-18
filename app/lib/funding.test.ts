import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  fundingDeadlineText,
  fundingDisplayPct,
  fundingLabel,
  fundingPct,
  fundingStatusText,
  isFundedPreorder,
  isFundingPublic,
} from './funding.ts';
import type {CatalogFunding, CatalogProduct} from './catalog.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/funding.test.ts

function funding(overrides: Partial<CatalogFunding> = {}): CatalogFunding {
  return {
    targetUnits: 500,
    unitsFunded: 312,
    // Carried for contract compatibility; fundingPct ignores it (see below).
    pct: 62.4,
    state: 'open',
    dateDeadline: '2026-12-01',
    ...overrides,
  };
}

describe('fundingPct', () => {
  it('derives from unitsFunded/targetUnits, rounded to an integer', () => {
    assert.equal(fundingPct(funding({unitsFunded: 312, targetUnits: 500})), 62);
    assert.equal(fundingPct(funding({unitsFunded: 313, targetUnits: 500})), 63);
  });

  it('ignores the catalog-supplied pct field entirely', () => {
    // A `pct` that disagrees with unitsFunded/targetUnits must never win:
    // the bar and the "N of 500 funded" label are computed from the same
    // two numbers, so they can never contradict each other.
    assert.equal(
      fundingPct(funding({unitsFunded: 312, targetUnits: 500, pct: 999})),
      62,
    );
    assert.equal(
      fundingPct(funding({unitsFunded: 312, targetUnits: 500, pct: Number.NaN})),
      62,
    );
  });

  it('clamps to 0-100', () => {
    assert.equal(fundingPct(funding({unitsFunded: -10, targetUnits: 500})), 0);
    assert.equal(fundingPct(funding({unitsFunded: 700, targetUnits: 500})), 100);
  });

  it('is 0 for no funding', () => {
    assert.equal(fundingPct(null), 0);
    assert.equal(fundingPct(undefined), 0);
  });

  it('is 0 for a non-finite unitsFunded/targetUnits or a non-positive target', () => {
    // A bar width of `NaN%` and `aria-valuenow="NaN"` is worse than a bar at
    // zero: the progressbar role requires a number inside 0-100.
    assert.equal(fundingPct(funding({unitsFunded: Number.NaN})), 0);
    assert.equal(fundingPct(funding({targetUnits: Number.NaN})), 0);
    assert.equal(fundingPct(funding({targetUnits: 0})), 0);
    assert.equal(fundingPct(funding({targetUnits: -500})), 0);
    assert.equal(fundingDisplayPct(funding({unitsFunded: Number.NaN})), 0);
    assert.equal(
      fundingDisplayPct(funding({unitsFunded: Number.NaN}), 'nearest-5'),
      0,
    );
  });
});

describe('isFundingPublic', () => {
  it('is true only for a campaign a buyer may see', () => {
    assert.equal(isFundingPublic(funding({state: 'open'})), true);
    assert.equal(isFundingPublic(funding({state: 'funded'})), true);
    assert.equal(isFundingPublic(funding({state: 'missed'})), true);
  });

  it('is false for draft, cancelled and no funding', () => {
    // A draft campaign is unpublished and a cancelled one is withdrawn.
    // Neither may leak a unit count or the refund guarantee to a buyer.
    assert.equal(isFundingPublic(funding({state: 'draft'})), false);
    assert.equal(isFundingPublic(funding({state: 'cancelled'})), false);
    assert.equal(isFundingPublic(null), false);
    assert.equal(isFundingPublic(undefined), false);
  });
});

describe('fundingDisplayPct', () => {
  it('is the exact rounded percentage by default', () => {
    assert.equal(
      fundingDisplayPct(funding({unitsFunded: 312, targetUnits: 500})),
      62,
    );
    assert.equal(
      fundingDisplayPct(funding({unitsFunded: 312, targetUnits: 500}), 'exact'),
      62,
    );
  });

  it('snaps to 5% steps when asked', () => {
    assert.equal(
      fundingDisplayPct(funding({unitsFunded: 312, targetUnits: 500}), 'nearest-5'),
      60,
    );
    assert.equal(
      fundingDisplayPct(funding({unitsFunded: 315, targetUnits: 500}), 'nearest-5'),
      65,
    );
    assert.equal(
      fundingDisplayPct(funding({unitsFunded: 10, targetUnits: 500}), 'nearest-5'),
      0,
    );
  });

  it('stays inside 0-100 at both precisions', () => {
    assert.equal(
      fundingDisplayPct(funding({unitsFunded: 700, targetUnits: 500}), 'nearest-5'),
      100,
    );
    assert.equal(
      fundingDisplayPct(funding({unitsFunded: -10, targetUnits: 500}), 'nearest-5'),
      0,
    );
    assert.equal(fundingDisplayPct(null, 'nearest-5'), 0);
  });
});

describe('fundingDeadlineText', () => {
  it('reads the deadline as an ISO day', () => {
    assert.equal(
      fundingDeadlineText(funding({dateDeadline: '2026-12-01'})),
      'Funding deadline 2026-12-01',
    );
  });

  it('is empty without a usable deadline', () => {
    assert.equal(fundingDeadlineText(funding({dateDeadline: null})), '');
    assert.equal(fundingDeadlineText(funding({dateDeadline: 'soon'})), '');
    assert.equal(fundingDeadlineText(funding({dateDeadline: '2026-13-45'})), '');
    assert.equal(fundingDeadlineText(null), '');
  });

  it('reads the same day in every timezone', () => {
    // Server-rendered in UTC, hydrated in the visitor's zone. Parsing the
    // string as a local instant shifts the day and React then reports a
    // hydration mismatch, so the day is read off the string itself.
    const zones = ['UTC', 'America/New_York', 'Pacific/Kiritimati'];
    for (const raw of ['2026-12-01', '2026-12-01T00:00:00', '2026-12-01 23:59:59']) {
      for (const zone of zones) {
        const before = process.env.TZ;
        process.env.TZ = zone;
        try {
          assert.equal(
            fundingDeadlineText(funding({dateDeadline: raw})),
            'Funding deadline 2026-12-01',
            `${raw} in ${zone}`,
          );
        } finally {
          process.env.TZ = before;
        }
      }
    }
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
