/**
 * Fixed keyword rules for the /support Ask box (`handleAsk` in chatfpv.ts).
 *
 * Order status, refunds, cancellations, double charges, transit damage,
 * warranty claims and address changes always need a human to pull up the
 * order, and bulk or club pricing always needs the wholesale form
 * (`app/routes/wholesale.tsx`), not chat. A language model can misjudge the
 * wording of any of these (baseline: it invented legal articles for a
 * double-charge question and never pointed a bulk-discount question at
 * /wholesale), so they route on fixed keywords instead of asking ChatFPV.
 *
 * Every pattern requires an order- or commerce-specific combination, never
 * a single common word (no bare "where", "ship" or "buy"), so an ordinary
 * product, compatibility or shipping-policy question is never caught. See
 * ask-rules.test.ts for the question set this is checked against.
 */

import type {Citation} from './chatfpv-contract.ts';

export type FixedHandoff = {reason: string; url?: string};

type Rule = {test: RegExp; reason: string; url?: string};

const RULES: Rule[] = [
  {
    test: /\b(bulk|wholesale|club|reseller)\b/i,
    reason: 'Bulk and club pricing goes through the wholesale form, not chat.',
    url: '/wholesale',
  },
  {
    test: /\bcharged\s+(twice|two times)\b|\bdouble[- ]charg/i,
    reason: 'A double charge needs a look at the order, so this goes to a ticket.',
  },
  {
    test: /\bdamage[ds]?\s+in\s+transit\b|\b(arrived|package|parcel)\b.*\bdamage[ds]?\b|\bdamage[ds]?\b.*\b(arrived|package|parcel|transit)\b/i,
    reason: 'Transit damage needs photos and the order on a ticket, not chat.',
  },
  {
    test: /\bwarrant(y|ied)\b/i,
    reason: 'Warranty claims need the order on a ticket, not chat.',
  },
  {
    test: /\b(change|update)\b.*\baddress\b|\baddress\b.*\b(change|update)\b/i,
    reason: 'Address changes need a ticket so the team can update the order before it ships.',
  },
  {
    test: /\brefund\b|\bcancel\b.*\border\b|\border\b.*\bcancel/i,
    reason: 'Refunds and cancellations need a ticket so the team can pull up the order.',
  },
  {
    test: /\bmy order\b.*\b(where|track|status)\b|\b(where|track|status)\b.*\bmy order\b|\bno tracking\b/i,
    reason: 'Order status and tracking need a ticket so the team can pull up the order.',
  },
];

/** The first fixed rule the message matches, or null. Checked before any ChatFPV call. */
export function matchFixedHandoff(message: string): FixedHandoff | null {
  for (const rule of RULES) {
    if (rule.test.test(message)) return {reason: rule.reason, ...(rule.url ? {url: rule.url} : {})};
  }
  return null;
}

export type FixedInfo = {text: string; citations: Citation[]};

/**
 * A preorder charge- or ship-timing question ("when am I charged", "when
 * will preorders ship"). This is published information (`/preorder`,
 * `/algemene-voorwaarden`), not a ticket matter, but ChatFPV's own store
 * handoff routing treats any mention of "preorder" as an order question and
 * hands it off anyway (baseline iteration 3: s01, s02). Checked after
 * `matchFixedHandoff` (a real refund or cancellation on a preorder still
 * goes to a ticket) and before ChatFPV ever sees the question, so this
 * repository's own routing decides it instead of relying on a fix
 * upstream in ChatFPV, which is out of this loop's scope.
 */
const PREORDER = /\bpre-?orders?\b/i;
const TIMING = /\bcharg|\bpay(?:ment|s|ing)?\b|\bship|\bwhen\b/i;

export function matchPreorderInfo(message: string): FixedInfo | null {
  if (!PREORDER.test(message) || !TIMING.test(message)) return null;
  return {
    text: 'When a preorder is charged and when it ships are on the preorder page and in the terms of sale; the dates there are the current ones.',
    citations: [
      {n: 1, title: 'Preorder', url: '/preorder#questions', source: 'OpenDrone storefront', kind: 'doc'},
      {n: 2, title: 'Terms of sale', url: '/algemene-voorwaarden', source: 'OpenDrone storefront', kind: 'doc'},
    ],
  };
}

/**
 * A VAT or non-EU/international shipping question ("is VAT included",
 * "do you ship to the US"). This is published information (`/shipping`),
 * not a ticket matter, but a customer asking it worded as a shipping
 * question can otherwise be handed to a ticket with generic "help with your
 * order" text (baseline iteration 1: s03 US shipping, s05 VAT). Checked
 * after `matchFixedHandoff` and `matchPreorderInfo` (an actual shipment's
 * customs problem or a wrong VAT charge on a placed order still goes to a
 * ticket) and before ChatFPV. Labelled as OpenDrone shop information, not an
 * AI answer, since it is a direct copy of the published shipping terms.
 */
const VAT_QUESTION = /\bvat\b|\bbtw\b/i;
const NON_EU_COUNTRY = /\b(us|usa|u\.s\.a?\.?|united states|uk|u\.k\.|united kingdom|canada|australia|switzerland|norway|japan)\b/i;
const SHIP_WORD = /\bship(?:ping|s|ped)?\b|\bdeliver(?:ed|ing|y|ies)?\b/i;
const OUTSIDE_EU = /\boutside (?:the )?(?:eu|europe)\b|\bnon[- ]eu\b|\binternational(?:ly)?\b/i;

export function matchShippingVatInfo(message: string): FixedInfo | null {
  const vat = VAT_QUESTION.test(message);
  const nonEuShipping = SHIP_WORD.test(message) && (NON_EU_COUNTRY.test(message) || OUTSIDE_EU.test(message));
  if (!vat && !nonEuShipping) return null;
  const text = vat
    ? 'Every price and shipping rate shown already includes VAT. Within the EU there are no customs formalities and no import duties after checkout.'
    : "Direct checkout only covers the EU countries offered at checkout, shipped from Belgium; VAT is included and there are no customs charges. Outside the EU, Incutec does not offer direct consumer checkout: retailers can request a bulk quote, and consumers can sign up for launch news for other countries.";
  return {
    text,
    citations: [{n: 1, title: 'Shipping and delivery', url: '/shipping', source: 'OpenDrone storefront', kind: 'doc'}],
  };
}
