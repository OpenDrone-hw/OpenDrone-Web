import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {campaignState, priceLadder, type CampaignBatch} from './preorder-campaign.ts';
import {barPercent, ladderText, meterView} from './preorder-meter.ts';

const PENDING = 'ships about 10 weeks after its target is reached';
const STACK: CampaignBatch[] = [{units: 250, paid: true, ships: 'ships late October 2026'}, {units: 250}];
const FRAME: CampaignBatch[] = [{units: 250}, {units: 1000}];
const TIERS = [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}];
const none = () => undefined;

describe('meterView', () => {
  it('shows paid stock as units left, with the price after batch 1', () => {
    const view = meterView(campaignState(STACK, 107, PENDING, TIERS), none, '€55.00');
    assert.equal(view.headline, 'Batch 1 is paid for and in production · 143 of 250 left');
    assert.equal(view.early, 'Preorder price for the first 250 · 143 left, then €55.00');
    assert.equal(view.bar, null);
    assert.equal(view.count, '143 left');
    assert.equal(view.stretch, null);
  });

  it('shows progress toward the first target with the price after it', () => {
    const view = meterView(campaignState(FRAME, 187, PENDING, TIERS), none, '€99.00');
    assert.equal(view.headline, '187 of 250 ordered toward the funding target');
    assert.equal(view.early, 'Preorder price for the first 250 · 63 left, then €99.00');
    assert.equal(barPercent(view.bar!), 75);
    assert.equal(view.count, '187 / 250');
  });

  it('drops the early-price line when Shopify has no higher price', () => {
    assert.equal(meterView(campaignState(FRAME, 1, PENDING, TIERS), none, null).early, null);
  });

  it('keeps a full bar after the target and fills the next batch below it', () => {
    const view = meterView(campaignState(FRAME, 312, PENDING, TIERS), none, '€99.00');
    assert.equal(view.headline, 'Funding target reached · 312 ordered');
    assert.equal(barPercent(view.bar!), 100);
    assert.equal(view.reached, true);
    assert.equal(view.stretch?.label, 'Batch 2: 62 of 1000');
    assert.equal(view.early, null);
  });

  it('reads its words from copy', () => {
    const view = meterView(campaignState(FRAME, 5, PENDING, TIERS), (key) =>
      key === 'meter_target' ? '{ordered}/{target}' : undefined,
    );
    assert.equal(view.headline, '5/250');
  });
});

describe('barPercent', () => {
  it('never returns NaN or leaves 0 to 100', () => {
    assert.equal(barPercent({value: 5, max: 0, label: ''}), 0);
    assert.equal(barPercent({value: Number.NaN, max: 10, label: ''}), 0);
    assert.equal(barPercent({value: 20, max: 10, label: ''}), 100);
  });
});

describe('ladderText', () => {
  const euro = (n: number) => `€${n.toFixed(2)}`;
  it('writes the whole ladder as plain text', () => {
    assert.equal(
      ladderText(priceLadder(39, TIERS), euro),
      '€31.20 for units 1-100 · €35.10 for units 101-250 · €39.00 from unit 251',
    );
  });
  it('takes its words from the copy lookup', () => {
    const text = (key: string) =>
      ({ladder_step: '{from} tot {to}: {price}', ladder_last: 'vanaf {from}: {price}'})[key];
    assert.equal(ladderText(priceLadder(10, [{upTo: 5, off: 0.5}]), euro, text), '1 tot 5: €5.00 · vanaf 6: €10.00');
  });
  it('is the price alone without steps', () => {
    assert.equal(ladderText(priceLadder(10, []), euro), '€10.00');
  });
});
