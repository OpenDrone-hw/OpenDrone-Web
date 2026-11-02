import assert from 'node:assert/strict';
import {test} from 'node:test';
import {availBannerLift, type Box} from './avail-banner-lift.ts';

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
