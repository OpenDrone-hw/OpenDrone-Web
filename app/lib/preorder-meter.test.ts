import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {campaignState, priceLadder, type CampaignBatch} from './preorder-campaign.ts';
import {barPercent, ladderText, reachableSteps, stepBarLabel, stepBarView, stepLayout} from './preorder-meter.ts';

const PENDING =
  'ships about 10 weeks after its target is reached: by 11 March 2027 if the target is reached by 31 December 2026, otherwise you choose a refund or to wait';
const STACK: CampaignBatch[] = [{units: 250, paid: true, ships: 'ships early November 2026'}, {units: 250}];
const FRAME: CampaignBatch[] = [{units: 250}, {units: 1000}];
const TIERS = [{upTo: 100, off: 0.2}, {upTo: 250, off: 0.1}];

describe('stepBarView', () => {
  const ENDS = TIERS.map((t) => t.upTo);

  it('counts paid stock sold out of batch 1, ticked at the step end inside it', () => {
    const bar = stepBarView(campaignState(STACK, 37, PENDING, TIERS), ENDS);
    assert.deepEqual(bar, {value: 37, max: 250, ticks: [100], funded: false, label: '37 / 250', kind: 'paid'});
  });

  it('ticks the EU and US bars of the same SKU identically', () => {
    const eu = stepBarView(campaignState(STACK, 1, PENDING, TIERS, null, 'EU'), ENDS);
    const us = stepBarView(campaignState([{units: 250, paid: true, ships: 'ships early November 2026', regions: ['EU']}, {units: 250}], 1, PENDING, TIERS, null, 'US'), ENDS);
    assert.deepEqual(eu.ticks, [100]);
    assert.deepEqual(us.ticks, eu.ticks);
    assert.equal(us.max, eu.max);
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

  it('stays at a reached target past it: no new target opens', () => {
    for (const ordered of [500, 850, 5000]) {
      const bar = stepBarView(campaignState(STACK, ordered, PENDING, TIERS), ENDS);
      assert.deepEqual([bar.funded, bar.value, bar.max], [true, 250, 250], `${ordered} ordered`);
    }
    const run = stepBarView(campaignState([{units: 250}], 1300, PENDING, TIERS), ENDS);
    assert.deepEqual([run.funded, run.label], [true, '250 / 250']);
  });

  it('drops the ticks once the bar counts a later batch', () => {
    const bar = stepBarView(campaignState(STACK, 260, PENDING, TIERS), ENDS);
    assert.equal(bar.label, '10 / 250');
    assert.deepEqual(bar.ticks, []);
  });
});

describe('step bar words and reachable steps', () => {
  const ENDS = TIERS.map((t) => t.upTo);

  it('reads a paid batch as a cap and a funding target as a goal', () => {
    const paid = stepBarView(campaignState(STACK, 37, PENDING, TIERS), ENDS);
    assert.equal(stepBarLabel(paid), '213 of 250 left');
    assert.equal(stepBarLabel(paid, 'batch 1'), '213 of 250 left in batch 1');
    const target = stepBarView(campaignState(FRAME, 37, PENDING, TIERS), ENDS);
    assert.equal(stepBarLabel(target), '37 / 250 target');
    assert.equal(stepBarLabel(target, 'the March 2027 batch'), '37 / 250 target for the March 2027 batch');
    assert.equal(stepBarLabel(paid, null, (key) => (key === 'meter_paid_left' ? '{left} left' : undefined)), '213 left');
  });

  it('hides a price step that starts past a paid batch cap, and keeps every step for a funding target', () => {
    const ladder = priceLadder(49, TIERS);
    assert.deepEqual(ladder.map((s) => s.from), [1, 101, 251]);
    assert.deepEqual(reachableSteps(campaignState(STACK, 37, PENDING, TIERS), ladder).map((s) => s.from), [1, 101]);
    assert.deepEqual(reachableSteps(campaignState(FRAME, 37, PENDING, TIERS), ladder).map((s) => s.from), [1, 101, 251]);
    // Past the paid batch the buyer is in the funding target: every step.
    assert.deepEqual(reachableSteps(campaignState(STACK, 260, PENDING, TIERS), ladder).map((s) => s.from), [1, 101, 251]);
  });
});

describe('stepLayout', () => {
  const ENDS = TIERS.map((t) => t.upTo);
  const FROMS = [1, 101, 251];

  it('places each step price over its own stretch of a 250-unit batch', () => {
    const state = campaignState(STACK, 37, PENDING, TIERS);
    const layout = stepLayout(state, stepBarView(state, ENDS), FROMS);
    assert.equal(layout?.tail, true);
    assert.equal(layout?.lefts.length, 3);
  });

  it('falls back to equal columns when the steps crowd a 1000-unit target', () => {
    const state = campaignState([{units: 1000}, {units: 4000}], 0, PENDING, TIERS);
    assert.equal(stepLayout(state, stepBarView(state, ENDS), FROMS), null);
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

describe('cart line ship chip', () => {
  it('carries the funding condition, as checkout does', async () => {
    const {readFileSync} = await import('node:fs');
    const chip = readFileSync(new URL('../components/ParcelChip.tsx', import.meta.url), 'utf8');
    assert.match(chip, /<ShipChip promise=\{parcel && promise \? parcel : promise\} className=\{className\} ifFunded \/>/);
    const copy = JSON.parse(readFileSync(new URL('../../content/copy/preorder.json', import.meta.url), 'utf8')) as Record<string, string>;
    assert.equal(copy.ship_eta_if_funded, 'Ships by {date} if the target is reached');
  });
});
