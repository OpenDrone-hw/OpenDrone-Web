import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import * as campaign from './preorder-campaign.ts';
import {parseArgs, planClose, planDeny} from '../../scripts/close-preorder-run.mjs';

const CONFIG = campaign.parseCampaignConfig({
  countFrom: '2026-09-25', endsOn: '2026-12-15', shipsBy: '2027-03-31',
  priceTiers: [{upTo: 100, off: 0.2}],
  pendingShips: 'ships by 31 March 2027 if the target is reached by 15 December 2026',
  skus: {
    'OPENFC-LITE-2020': {batches: [{units: 250, paid: true, ships: 'ships early November 2026', regions: ['EU']}, {units: 250}]},
    'OPENRX-LITE': {batches: [{units: 250}]},
  },
  shipsWith: {
    'ACC-STRAP-20X220': {sku: 'OPENFC-LITE-2020', batch: 1},
    'ACC-PROP-3-GF-3020': {sku: 'OPENFC-LITE-2020', batch: 2},
    'ACC-FRM-ARM-3': {sku: 'OPENRX-LITE'},
  },
});

describe('close-preorder-run', () => {
  it('refuses unknown arguments and reads nothing for --help', () => {
    assert.deepEqual(parseArgs([]), {apply: false, help: false});
    assert.equal(parseArgs(['--apply']).apply, true);
    assert.equal(parseArgs(['--apply', '--help']).help, true);
    assert.throws(() => parseArgs(['--force']), /unknown argument/);
  });

  it('closes the SKUs whose next EU unit waits for a funding target and keeps paid stock and dated batches', () => {
    assert.deepEqual(planClose(campaign, CONFIG, {}), {
      close: ['OPENRX-LITE', 'ACC-PROP-3-GF-3020', 'ACC-FRM-ARM-3'],
      keep: ['OPENFC-LITE-2020', 'ACC-STRAP-20X220'],
    });
    // Paid stock sold out: the lead's next unit waits for the target too.
    assert.ok(planClose(campaign, CONFIG, {'OPENFC-LITE-2020': 250}).close.includes('OPENFC-LITE-2020'));
  });

  it('writes DENY only for CONTINUE variants and names those DENY cannot stop', () => {
    const v = (sku: string, policy: string, tracked: boolean, qty: number, product = 'p1') => ({
      id: `v-${sku}`, sku, inventoryPolicy: policy, inventoryQuantity: qty, inventoryItem: {tracked}, product: {id: product},
    });
    const {writes, lines} = planDeny(
      ['A', 'B', 'C', 'D', 'E'],
      [v('A', 'CONTINUE', true, 0), v('B', 'DENY', true, 0), v('C', 'CONTINUE', false, 0, 'p2'), v('D', 'CONTINUE', true, 3)],
    );
    assert.deepEqual(writes, [
      {productId: 'p1', variants: [{id: 'v-A', inventoryPolicy: 'DENY'}, {id: 'v-D', inventoryPolicy: 'DENY'}]},
      {productId: 'p2', variants: [{id: 'v-C', inventoryPolicy: 'DENY'}]},
    ]);
    assert.deepEqual(lines, [
      '  A: CONTINUE -> DENY',
      '  B: already DENY',
      '  C: CONTINUE -> DENY, inventory not tracked: DENY does not stop a sale',
      '  D: CONTINUE -> DENY, 3 in stock: DENY still sells them',
      '  E: not in Shopify',
    ]);
  });
});
