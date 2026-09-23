import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {campaignState, priceLadder, type CampaignBatch} from './preorder-campaign.ts';
import {barPercent, ladderText, stepBarView} from './preorder-meter.ts';

const PENDING =
  'ships about 10 weeks after its target is reached: by 11 March 2027 if the target is reached by 31 December 2026, otherwise you choose a refund or to wait';
const STACK: CampaignBatch[] = [{units: 250, paid: true, ships: 'ships late October 2026'}, {units: 250}];
const FRAME: CampaignBatch[] = [{units: 250}, {units: 1000}];
const TIERS = [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}];

describe('stepBarView', () => {
  const ENDS = TIERS.map((t) => t.upTo);

  it('counts paid stock sold out of batch 1, ticked at the step end inside it', () => {
    const bar = stepBarView(campaignState(STACK, 37, PENDING, TIERS), ENDS);
    assert.deepEqual(bar, {value: 37, max: 250, ticks: [100], funded: false, label: '37 / 250'});
  });

  it('shows an empty target as 0 of its size, both step ends inside a 1000 target', () => {
    const bar = stepBarView(campaignState([{units: 1000}, {units: 4000}], 0, PENDING, TIERS), ENDS);
    assert.equal(bar.label, '0 / 1000');
    assert.deepEqual(bar.ticks, [100, 250]);
  });

  it('fills a reached target', () => {
    const bar = stepBarView(campaignState(FRAME, 300, PENDING, TIERS), ENDS);
    assert.equal(bar.funded, true);
    assert.equal(bar.value, bar.max);
  });

  it('drops the ticks once the bar counts a later batch', () => {
    const bar = stepBarView(campaignState(STACK, 260, PENDING, TIERS), ENDS);
    assert.equal(bar.label, '10 / 250');
    assert.deepEqual(bar.ticks, []);
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
