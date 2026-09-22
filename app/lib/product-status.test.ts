import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  hasExplicitPurchasableStatus,
  isComingSoon,
  isConceptFor,
  isConceptProduct,
  isPurchasableStatus,
  resolveStatus,
  PRODUCT_CONTENT,
} from './product-content.ts';
import {statusForHandle} from './roadmap-data.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/product-status.test.ts

/**
 * Run `fn` with the handle's explicit `status` (and legacy `comingSoon`)
 * lifted, so the roadmap and the global flag decide as they do for a
 * product whose content file carries no status. The boards ship as
 * pre-orders today, so their files DO carry one.
 */
function withoutExplicitStatus(handle: string, fn: () => void) {
  const saved = PRODUCT_CONTENT[handle];
  PRODUCT_CONTENT[handle] = {...saved, status: undefined, comingSoon: undefined};
  try {
    fn();
  } finally {
    PRODUCT_CONTENT[handle] = saved;
  }
}

describe('resolveStatus', () => {
  it('follows the global flag only for handles off the roadmap', () => {
    assert.equal(resolveStatus('battery-strap', true), 'development');
    assert.equal(resolveStatus('battery-strap', false), 'live');
  });

  it('the roadmap decides for roadmap products, whatever the global flag', () => {
    // Static roadmap: every board is alpha today -> waitlist, no price,
    // on a locked AND an open shop alike.
    withoutExplicitStatus('openesc', () => {
      for (const flag of [true, false]) {
        assert.equal(resolveStatus('openesc', flag), 'development');
        assert.equal(isComingSoon('openesc', flag), true);
      }
    });
  });

  it('a status-beta topic is the release act: price + orderable', () => {
    // The flag map is keyed by repo URL, as fetchStatusFlags returns it.
    // Beta unlocks even while the global pre-launch flag is still set.
    withoutExplicitStatus('openesc', () => {
      const flags = {
        'https://github.com/OpenDrone-hw/OpenESC-20x20': 'beta',
      } as const;
      assert.equal(resolveStatus('openesc', true, flags), 'live');
      assert.equal(isComingSoon('openesc', true, flags), false);
      // ...and moving it back down locks it again.
      const down = {
        'https://github.com/OpenDrone-hw/OpenESC-20x20': 'in-progress',
        'https://github.com/OpenDrone-hw/OpenESC-30x30': 'in-progress',
      } as const;
      assert.equal(resolveStatus('openesc', false, down), 'development');
    });
  });

  it('a page with two boards sells on its furthest-along board', () => {
    // OpenESC page carries 20x20 and 30x30; one beta board is enough.
    withoutExplicitStatus('openesc', () => {
      const flags = {
        'https://github.com/OpenDrone-hw/OpenESC-30x30': 'beta',
      } as const;
      assert.equal(resolveStatus('openesc', true, flags), 'live');
    });
  });

  it('treats unknown handles like unset products', () => {
    assert.equal(resolveStatus('no-such-product', true), 'development');
    assert.equal(resolveStatus(null, false), 'live');
    assert.equal(resolveStatus(undefined, true), 'development');
  });

  it('lets an explicit status override the global flag', () => {
    PRODUCT_CONTENT['__test-idea'] = {
      ...PRODUCT_CONTENT.openesc,
      status: 'idea',
    };
    PRODUCT_CONTENT['__test-live'] = {
      ...PRODUCT_CONTENT.openesc,
      status: 'live',
    };
    try {
      assert.equal(resolveStatus('__test-idea', false), 'idea');
      assert.equal(resolveStatus('__test-live', true), 'live');
    } finally {
      delete PRODUCT_CONTENT['__test-idea'];
      delete PRODUCT_CONTENT['__test-live'];
    }
  });

  it('maps the legacy comingSoon boolean when no status is set', () => {
    PRODUCT_CONTENT['__test-legacy'] = {
      ...PRODUCT_CONTENT.openesc,
      status: undefined,
      comingSoon: false,
    };
    try {
      assert.equal(resolveStatus('__test-legacy', true), 'live');
      PRODUCT_CONTENT['__test-legacy'].comingSoon = true;
      assert.equal(resolveStatus('__test-legacy', false), 'development');
    } finally {
      delete PRODUCT_CONTENT['__test-legacy'];
    }
  });

  it('explicit status beats the legacy boolean', () => {
    PRODUCT_CONTENT['__test-both'] = {
      ...PRODUCT_CONTENT.openesc,
      status: 'live',
      comingSoon: true,
    };
    try {
      assert.equal(resolveStatus('__test-both', true), 'live');
    } finally {
      delete PRODUCT_CONTENT['__test-both'];
    }
  });

  it('preorder waits for the shop to open', () => {
    // The boards' content files carry status: "preorder" (verified, not
    // assumed, so a content edit that drops it fails here first).
    for (const handle of ['openesc', 'openfc-lite', 'openrx', 'openframe']) {
      assert.equal(PRODUCT_CONTENT[handle]?.status, 'preorder', handle);
      // Global flag on: rendered as development, no orders taken.
      assert.equal(resolveStatus(handle, true), 'development', handle);
      // Flag off: the shop is open, so is the pre-order.
      assert.equal(resolveStatus(handle, false), 'preorder', handle);
    }
  });

  describe("the catalog availability", () => {
    it('decides who is orderable once the shop is open', () => {
      assert.equal(resolveStatus('openesc', false, {}, 'in_stock'), 'live');
      assert.equal(resolveStatus('openesc', false, {}, 'preorder'), 'preorder');
      // sold_out is a live product with nothing on the shelf: the page
      // shows the price and the sold-out state, not a launch teaser.
      assert.equal(resolveStatus('openesc', false, {}, 'sold_out'), 'live');
    });

    it('never outranks the global kill switch', () => {
      // A product the catalog already calls in stock must still read as
      // coming soon before launch day, or the kill switch is decorative.
      assert.equal(resolveStatus('openesc', true, {}, 'in_stock'), 'development');
      assert.equal(resolveStatus('openesc', true, {}, 'preorder'), 'development');
      assert.equal(resolveStatus('openesc', true, {}, 'sold_out'), 'development');
    });

    it('never overrides a local idea or development status', () => {
      PRODUCT_CONTENT['__test-idea-catalog'] = {
        ...PRODUCT_CONTENT.openesc,
        status: 'idea',
      };
      try {
        assert.equal(
          resolveStatus('__test-idea-catalog', false, {}, 'in_stock'),
          'idea',
        );
      } finally {
        delete PRODUCT_CONTENT['__test-idea-catalog'];
      }
    });

    it('beats the roadmap topic for a product the shop sells', () => {
      const alpha = {
        'https://github.com/OpenDrone-hw/OpenESC-20x20': 'alpha',
      } as const;
      assert.equal(
        resolveStatus('battery-strap', false, alpha, 'in_stock'),
        'live',
      );
    });

    it('yields to an explicit live status in the content file', () => {
      PRODUCT_CONTENT['__test-live-catalog'] = {
        ...PRODUCT_CONTENT.openesc,
        status: 'live',
      };
      try {
        assert.equal(
          resolveStatus('__test-live-catalog', true, {}, 'sold_out'),
          'live',
        );
      } finally {
        delete PRODUCT_CONTENT['__test-live-catalog'];
      }
    });
  });

  it('preorder wins over the roadmap topic like any explicit status', () => {
    // A beta topic does not turn a pre-order into "in stock", and an alpha
    // topic does not lock it once the shop is open.
    const beta = {
      'https://github.com/OpenDrone-hw/OpenESC-20x20': 'beta',
    } as const;
    assert.equal(resolveStatus('openesc', false, beta), 'preorder');
    assert.equal(resolveStatus('openesc', true, beta), 'development');
  });
});

describe('isPurchasableStatus', () => {
  it('is true for live and preorder only', () => {
    assert.equal(isPurchasableStatus('live'), true);
    assert.equal(isPurchasableStatus('preorder'), true);
    assert.equal(isPurchasableStatus('development'), false);
    assert.equal(isPurchasableStatus('idea'), false);
  });
});

describe('concept gate', () => {
  it('an explicit purchasable status lifts the gate, the chip keeps its word', () => {
    // The frame is in-progress on the static roadmap but takes pre-orders.
    assert.equal(statusForHandle('openframe'), 'in-progress');
    assert.equal(hasExplicitPurchasableStatus('openframe'), true);
    assert.equal(isConceptProduct('openframe'), false);
    assert.equal(isConceptFor('openframe', 'in-progress'), false);
    // The roadmap word is untouched: it is display vocabulary for the chip.
    assert.equal(statusForHandle('openframe'), 'in-progress');
    // Without the explicit status the roadmap word gates it again.
    withoutExplicitStatus('openframe', () => {
      assert.equal(hasExplicitPurchasableStatus('openframe'), false);
      assert.equal(isConceptProduct('openframe'), true);
      assert.equal(isConceptFor('openframe', 'in-progress'), true);
    });
  });

  it('idea and development statuses do not lift the gate', () => {
    PRODUCT_CONTENT['__test-idea'] = {
      ...PRODUCT_CONTENT.openframe,
      status: 'idea',
    };
    try {
      assert.equal(hasExplicitPurchasableStatus('__test-idea'), false);
      assert.equal(isConceptFor('__test-idea', 'planned'), true);
      assert.equal(isConceptFor('__test-idea', 'alpha'), false);
      assert.equal(isConceptFor(null, 'planned'), true);
      assert.equal(isConceptFor('battery-strap', undefined), false);
    } finally {
      delete PRODUCT_CONTENT['__test-idea'];
    }
  });
});

describe('isComingSoon', () => {
  it('is true for every non-purchasable status', () => {
    PRODUCT_CONTENT['__test-idea'] = {
      ...PRODUCT_CONTENT.openesc,
      status: 'idea',
    };
    try {
      assert.equal(isComingSoon('__test-idea', false), true);
      // openesc is on the roadmap (alpha today) so, without its explicit
      // status, the open-shop flag does not unlock it; an off-roadmap
      // accessory follows the flag.
      withoutExplicitStatus('openesc', () => {
        assert.equal(isComingSoon('openesc', true), true);
        assert.equal(isComingSoon('openesc', false), true);
      });
      assert.equal(isComingSoon('battery-strap', false), false);
    } finally {
      delete PRODUCT_CONTENT['__test-idea'];
    }
  });

  it('is false for a pre-order product once it takes orders', () => {
    assert.equal(isComingSoon('openrx', true), true);
    assert.equal(isComingSoon('openrx', false), false);
    // The catalog saying in_stock is just as purchasable.
    assert.equal(isComingSoon('openrx', false, {}, 'in_stock'), false);
    // ...but the kill switch still outranks it for a pre-order.
    assert.equal(isComingSoon('openrx', true, {}, 'preorder'), true);
  });
});
