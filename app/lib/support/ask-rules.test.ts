import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {matchFixedHandoff, matchPreorderInfo} from './ask-rules.ts';

// The order, compat, shipping and offtopic questions from the iteration-1
// baseline eval (chatfpv-work/loop/storefront/i1/questions-40.jsonl):
// none of these may ever match a fixed rule.
const SHOULD_ANSWER = [
  'What processor does the OpenFC Lite use?',
  'What mounting pattern does the OpenFC Lite have?',
  'Which firmware does the OpenFC Lite run, Betaflight or INAV?',
  'How many amps can the OpenESC handle continuously?',
  'What input voltage range does the OpenESC support? Can I run 6S?',
  'What firmware runs on the OpenESC?',
  'Is the OpenRX an ExpressLRS receiver? Which frequency band?',
  'What variants of the OpenRX are there?',
  'What size props does the OpenFrame take?',
  'Can I buy spare arms for the OpenFrame?',
  'What KV is the OpenMotor?',
  'Are OpenDrone boards open source, and under which licence?',
  'Where can I find the schematics for the OpenFC Lite?',
  'Is the OpenESC a 4-in-1 ESC or individual ESCs?',
  'What antenna connector does the OpenRX use?',
  'Will the OpenFC Lite work with a DJI O3 air unit?',
  'Can I use the OpenFC Lite with a non-OpenDrone 4-in-1 ESC?',
  'Which UART should I connect the OpenRX to on the OpenFC Lite?',
  'Does the OpenESC support bidirectional DShot for RPM filtering?',
  'Can I bind the OpenRX to a Radiomaster TX16S with an internal ELRS module?',
  'Will the OpenMotor fit a 5 inch frame with 16x16 motor mounts?',
  'How do I flash new firmware to the OpenESC?',
  'Why do I need a low ESR capacitor on my ESC?',
  'What battery should I use for a 5 inch freestyle build?',
  "My motors beep but won't arm in Betaflight, what should I check?",
  'How does the preorder work, when am I charged?',
  'When will preorders ship?',
  'Do you ship to the United States?',
  'Where is OpenDrone based and where do orders ship from?',
  'Do prices include VAT?',
  'Write me a poem about cats.',
  "What's the best stock to buy right now?",
];

const HANDOFF: Array<{q: string; url?: string}> = [
  {q: 'Where is my order? I ordered last week and have no tracking yet.'},
  {q: 'I want a refund for my preorder.'},
  {q: 'My OpenESC arrived with a burnt MOSFET, can I get a replacement under warranty?'},
  {q: 'Can I change the shipping address on my order?'},
  {q: 'I was charged twice for the same order.'},
  {q: 'Can I cancel my order and return the frame?'},
  {q: 'Can you give me a discount if I buy 20 flight controllers for my club?', url: '/wholesale'},
  {q: 'My package was damaged in transit, what do I do?'},
];

describe('matchFixedHandoff', () => {
  it('never catches a product, compatibility, shipping or offtopic question', () => {
    for (const q of SHOULD_ANSWER) {
      assert.equal(matchFixedHandoff(q), null, q);
    }
  });

  it('catches every order, refund, warranty, damage, address and bulk question', () => {
    for (const {q, url} of HANDOFF) {
      const m = matchFixedHandoff(q);
      assert.ok(m, q);
      assert.ok(m!.reason.length > 0, q);
      assert.equal(m!.url, url, q);
    }
  });

  it('does not confuse a variant-scoped product question with an order question', () => {
    assert.equal(matchFixedHandoff('How many amps can the OpenESC 30x30 handle continuously?'), null);
  });
});

describe('matchPreorderInfo', () => {
  it('answers a preorder charge/ship timing question with the preorder and terms pages', () => {
    for (const q of ['How does the preorder work, when am I charged?', 'When will preorders ship?', 'When do you charge my card for a pre-order?']) {
      const info = matchPreorderInfo(q);
      assert.ok(info, q);
      assert.ok(info!.text.length > 0);
      assert.deepEqual(info!.citations.map((c) => c.url), ['/preorder#questions', '/algemene-voorwaarden']);
    }
  });

  it('never matches a question with no "preorder" in it, even about shipping or charges', () => {
    const PREORDER_TIMING = new Set(['How does the preorder work, when am I charged?', 'When will preorders ship?']);
    for (const q of SHOULD_ANSWER.filter((q) => !PREORDER_TIMING.has(q))) assert.equal(matchPreorderInfo(q), null, q);
  });

  it('does not swallow a real refund or cancellation on a preorder', () => {
    assert.equal(matchPreorderInfo('I want a refund for my preorder.'), null);
    assert.equal(matchPreorderInfo('Can I cancel my preorder and return the frame?'), null);
  });
});
