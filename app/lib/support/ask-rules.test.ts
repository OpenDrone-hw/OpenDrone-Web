import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {matchFixedHandoff, matchPreorderInfo, matchShippingVatInfo} from './ask-rules.ts';

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

describe('matchShippingVatInfo', () => {
  it('answers a VAT question and a non-EU shipping question from /shipping', () => {
    for (const q of ['Do prices include VAT?', 'Is VAT included in the price?', 'Do you ship to the United States?', 'Can you deliver outside the EU?']) {
      const info = matchShippingVatInfo(q);
      assert.ok(info, q);
      assert.ok(info!.text.length > 0, q);
      assert.deepEqual(info!.citations.map((c) => c.url), ['/shipping']);
    }
  });

  it('never catches an ordinary product, compatibility or offtopic question', () => {
    const VAT_SHIPPING = new Set(['Do you ship to the United States?', 'Do prices include VAT?']);
    for (const q of SHOULD_ANSWER.filter((q) => !VAT_SHIPPING.has(q))) assert.equal(matchShippingVatInfo(q), null, q);
  });

  it('does not swallow a real order-shipping problem (still a handoff)', () => {
    assert.equal(matchShippingVatInfo('My package was damaged in transit, what do I do?'), null);
    assert.equal(matchShippingVatInfo('Can I change the shipping address on my order?'), null);
  });
});

// The storefront-launch iteration 2 precision probe
// (chatfpv-work/loop/storefront-launch/b2/rule-probe.txt): 12 questions found
// 7 wrong answers (the pronoun "us" read as the country, and any VAT
// mention answered as "included"). Grown to 30 (en/nl/fr) and pinned here so
// the rule can never regress silently.
const SHIPPING_VAT_PROBE: Array<{q: string; answered: boolean}> = [
  // Non-EU shipping: real non-EU destinations, still answered.
  {q: 'Do you ship to the United States?', answered: true},
  {q: 'Do you ship to the US?', answered: true},
  {q: 'Do you ship to the UK?', answered: true},
  {q: 'Ship to Norway?', answered: true},
  {q: 'Do you ship to Switzerland?', answered: true},
  {q: 'Do you ship to Japan?', answered: true},
  {q: 'Do you ship to Australia?', answered: true},
  {q: 'Do you ship internationally?', answered: true},
  {q: 'Can you deliver outside the EU?', answered: true},
  // The pronoun "us" naming an EU country: never a non-EU answer (the bug).
  {q: 'Can you ship to us in Germany?', answered: false},
  {q: 'Could you deliver it to us in Belgium by Friday?', answered: false},
  {q: 'How fast do you ship to us in the Netherlands?', answered: false},
  {q: 'Kunnen jullie leveren aan ons in Nederland?', answered: false},
  {q: 'Livrez-vous chez nous en France?', answered: false},
  // Lower-case "us" is the pronoun, not the country: never fires on it alone.
  {q: 'do you ship to the us?', answered: false},
  // A hardware-spec word, not a shipping question (the bug).
  {q: 'Is the VTX delivered with a US or EU power plug?', answered: false},
  {q: 'Does the ESC deliver 60A continuous for us?', answered: false},
  // No ship/deliver word at all: falls through to ChatFPV, unchanged.
  {q: 'Does OpenRX ship with the antenna?', answered: false},
  // VAT-included: a plain consumer question, still answered, en/nl/fr.
  {q: 'Do prices include VAT?', answered: true},
  {q: 'Is VAT included in the price?', answered: true},
  {q: 'Wat kost verzending naar Nederland, incl btw?', answered: true},
  {q: 'Is BTW inbegrepen in de prijs?', answered: true},
  {q: 'Est-ce que la TVA est comprise dans le prix?', answered: true},
  {q: 'Is VAT included when I ship to Germany?', answered: true},
  // Invoice, company, VAT-number and reverse-charge: need the order or
  // company details, never the rate-card answer (the bug).
  {q: 'Can I get a VAT invoice for my company?', answered: false},
  {q: 'Do I need to pay VAT as a business with a VAT number (reverse charge)?', answered: false},
  {q: "What's your VAT number?", answered: false},
  {q: 'Kan ik een factuur met BTW-nummer krijgen?', answered: false},
  {q: 'Puis-je avoir une facture avec autoliquidation de la TVA?', answered: false},
  // A bare VAT mention with no "included" word: not the rate-card question.
  {q: 'What is the price with VAT for the OpenESC?', answered: false},
];

describe('matchShippingVatInfo precision probe (storefront-launch iteration 2)', () => {
  it('matches exactly the intended 12 of 30, not the pronoun/product/invoice false positives', () => {
    for (const {q, answered} of SHIPPING_VAT_PROBE) {
      const info = matchShippingVatInfo(q);
      assert.equal(info !== null, answered, q);
    }
  });
});

/**
 * The full /support Ask box routing pipeline, in the order `handleAsk`
 * (chatfpv.ts) checks it: a fixed handoff first, then the preorder-timing
 * rule, then the shipping/VAT rule, then (not modelled here) ChatFPV
 * itself. Used only to test routing outcomes end to end; it does not build
 * `AskResult` bodies.
 */
type Route = 'handoff' | 'preorder' | 'shipvat' | 'chatfpv';
function route(message: string): Route {
  if (matchFixedHandoff(message)) return 'handoff';
  if (matchPreorderInfo(message)) return 'preorder';
  if (matchShippingVatInfo(message)) return 'shipvat';
  return 'chatfpv';
}

// storefront-launch iteration 3 held-out probe
// (chatfpv-work/loop/storefront-launch/i3/rule-probe.mts, run against PR
// #503's merged state, `22f08f3`): 7 of these 18 got a confident-wrong
// answer from the shipping/VAT rule instead of the outcome below. A
// question the rule now misses (falls through to ChatFPV) is not wrong, so
// only 'handoff' and 'shipvat' are asserted exactly; 'chatfpv' here means
// "must not be handoff or shipvat", checked with `assert.notEqual` so the
// pinned case still holds even if a future change makes the rule literally
// unable to run (e.g. if it were ever deleted, per this iteration's own
// plan: "a question that falls through to ChatFPV is not a confident-wrong
// answer").
const HELD_OUT_PROBE: Array<{q: string; expect: Route | 'not-handoff-or-shipvat'}> = [
  {q: 'Is the VTX shipped with US frequency lock?', expect: 'not-handoff-or-shipvat'},
  {q: 'Do you include VAT on invoices for businesses?', expect: 'not-handoff-or-shipvat'},
  {q: 'I was charged VAT twice, is that included?', expect: 'handoff'},
  {q: 'Why was VAT included on my order from Norway?', expect: 'handoff'},
  {q: 'Do you ship to the U.S.?', expect: 'shipvat'},
  {q: 'Does the OpenRX ship with US FCC firmware or EU LBT?', expect: 'not-handoff-or-shipvat'},
  {q: 'My package to the USA was stuck in customs, VAT included?', expect: 'handoff'},
  {q: 'Can I buy it with VAT excluded as a Swiss customer?', expect: 'not-handoff-or-shipvat'},
  {q: 'Is VAT included in the OpenESC price?', expect: 'shipvat'},
  {q: 'Was VAT included on my invoice for order 1234?', expect: 'handoff'},
  {q: 'Do you deliver to Canada?', expect: 'shipvat'},
  {q: 'Is the OpenMotor shipped with US or metric screws?', expect: 'not-handoff-or-shipvat'},
  {q: 'Can companies get VAT-free invoices?', expect: 'not-handoff-or-shipvat'},
  {q: 'I paid VAT but I am in the UK, can I get it back?', expect: 'handoff'},
  {q: 'Does shipping to Norway include VAT?', expect: 'shipvat'},
  {q: 'What frequencies does the OpenRX use in the US?', expect: 'not-handoff-or-shipvat'},
  {q: 'Delivering to the United States, how long does it take?', expect: 'shipvat'},
  {q: 'Do the prices include VAT for Belgium?', expect: 'shipvat'},
];

describe('storefront-launch iteration 3 held-out probe: 0 confident-wrong of 18', () => {
  it('never answers a product question or an order-specific VAT/customs problem from the rate card', () => {
    for (const {q, expect} of HELD_OUT_PROBE) {
      const got = route(q);
      if (expect === 'not-handoff-or-shipvat') {
        assert.notEqual(got, 'handoff', q);
        assert.notEqual(got, 'shipvat', q);
      } else {
        assert.equal(got, expect, q);
      }
    }
  });

  it('still catches every order/refund handoff (h01-h08) unchanged', () => {
    for (const {q} of HANDOFF) assert.equal(route(q), 'handoff', q);
  });
});

describe('VAT_EXCLUDE plural fix', () => {
  it('excludes the plural of invoice, business and company, not only the singular', () => {
    for (const q of [
      'Do you include VAT on invoices for businesses?',
      'Can businesses get invoices with VAT included?',
      'Do companies get VAT included on their invoices?',
    ]) {
      assert.equal(matchShippingVatInfo(q), null, q);
    }
  });
});

describe('US_UNAMBIGUOUS trailing punctuation fix', () => {
  it('matches "U.S." immediately followed by punctuation, not only end of string', () => {
    for (const q of ['Do you ship to the U.S.?', 'Ship to the U.S., please.']) {
      assert.ok(matchShippingVatInfo(q), q);
    }
  });
});

describe('"shipped with" / "comes with" is a product question, never a shipping-destination one', () => {
  it('never fires the non-EU shipping answer on a product-contents phrasing', () => {
    for (const q of [
      'Is the VTX shipped with US frequency lock?',
      'Does the OpenRX ship with US FCC firmware or EU LBT?',
      'Is the OpenMotor shipped with US or metric screws?',
      'Does the ESC come with a US power plug?',
    ]) {
      assert.equal(matchShippingVatInfo(q), null, q);
    }
  });

  it('still answers a real "do you ship to X" destination question', () => {
    assert.ok(matchShippingVatInfo('Do you ship to the United States?'));
  });
});
