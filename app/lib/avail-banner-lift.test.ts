import assert from 'node:assert/strict';
import {test} from 'node:test';
import {availBannerLift, stableBannerLift, type Box} from './avail-banner-lift.ts';

// 1512x792: card at rest bottom-left (as measured on staging), hero wordmark + GitHub link in the same corner.
const H = 792;
const card: Box = {left: 15, right: 392, top: 700, bottom: 762};
const wordmark: Box = {left: 40, right: 390, top: 712, bottom: 776};
const github: Box = {left: 420, right: 486, top: 710, bottom: 776};

test('no avoid elements: the card stays where it is', () => {
  assert.equal(availBannerLift(card, [], H, 12), 0);
});

test('the card rises to sit a gap above the hero wordmark', () => {
  const lift = availBannerLift(card, [wordmark, github], H, 12);
  assert.equal(lift, 762 - 712 + 12);
  assert.ok(card.bottom - lift + 12 <= wordmark.top, 'card bottom + gap clears the wordmark');
});

test('elements outside the card column, off screen or empty are ignored', () => {
  assert.equal(availBannerLift(card, [github], H, 12), 0, 'GitHub link to the right of the card');
  assert.equal(availBannerLift(card, [{...wordmark, top: -200, bottom: -100}], H, 12), 0, 'scrolled away');
  assert.equal(availBannerLift(card, [{...wordmark, top: 900, bottom: 960}], H, 12), 0, 'below the fold');
  assert.equal(availBannerLift(card, [{...wordmark, bottom: wordmark.top}], H, 12), 0, 'zero height');
  assert.equal(availBannerLift(card, [{left: 15, right: 392, top: 300, bottom: 400}], H, 12), 0, 'far above the card');
});

test('rising onto a second element keeps going until nothing overlaps', () => {
  const above: Box = {left: 20, right: 200, top: 640, bottom: 700};
  const lift = availBannerLift(card, [wordmark, above], H, 12);
  assert.equal(lift, 762 - 640 + 12);
});


test('hysteresis: rises once, then holds while the wordmark slides or fades, drops only when clear', () => {
  const need = 762 - 712 + 12;
  // at rest, wordmark fully shown and overlapping: rise
  const l1 = stableBannerLift(0, card, [wordmark], [wordmark], H, 12, 16);
  assert.equal(l1, need);
  // wordmark slides down 5px (or up 5px): the card does not re-position
  assert.equal(stableBannerLift(l1, card, [{...wordmark, top: 717, bottom: 781}], [{...wordmark, top: 717, bottom: 781}], H, 12, 16), l1);
  // wordmark fading (below the strict opacity, still in the loose set): hold
  assert.equal(stableBannerLift(l1, card, [], [wordmark], H, 12, 16), l1);
  // just outside gap but inside gap + hysteresis: hold (no flicker at the threshold)
  const near: Box = {...card, top: card.bottom + 14, bottom: card.bottom + 40};
  assert.equal(stableBannerLift(l1, card, [], [near], H, 12, 16), l1);
  // gone: drop back to rest
  assert.equal(stableBannerLift(l1, card, [], [], H, 12, 16), 0);
  // at rest, a faint element (loose only) never lifts the card
  assert.equal(stableBannerLift(0, card, [], [wordmark], H, 12, 16), 0);
});

test('hysteresis: alternating inputs at the boundary do not make the card oscillate', () => {
  let lift = 0;
  const seq: number[] = [];
  for (let i = 0; i < 10; i++) {
    const shown = i % 2 === 0; // wordmark opacity flickers around the strict threshold
    lift = stableBannerLift(lift, card, shown ? [wordmark] : [], [wordmark], H, 12, 16);
    seq.push(lift);
  }
  assert.equal(new Set(seq).size, 1, `one position only: ${seq.join(',')}`);
});
