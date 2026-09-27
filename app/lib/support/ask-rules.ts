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
 *
 * storefront-launch iteration 2 audit (chatfpv-work/loop/storefront-launch/
 * SUMMARY-2.md, b2/rule-probe.txt): the previous version read the pronoun
 * "us" as the country and fired on any VAT mention, giving 7 wrong answers
 * of 12 probed. This version requires the word to be unambiguously a
 * country ("US" only as literal uppercase, or an unambiguous form such as
 * "USA"/"U.S."/"United States"), never fires once an EU country or a
 * hardware-spec word (a plug, an amperage, "continuous") is also named, and
 * only answers the VAT rule for an "is VAT included" consumer question,
 * never an invoice, company, VAT-number or reverse-charge one (those still
 * reach ChatFPV or a ticket, since they need the actual order or company
 * details, not the published rate card).
 */
const VAT_QUESTION = /\bvat\b|\bbtw\b|\btva\b/i;
/** "included" in the three copy languages this rule answers in (see ask-rules.test.ts). */
const VAT_INCLUDED_TERM = /\binclud(?:e|ed|es|ing)?\b|\bincl\.?\b|\binclusive\b|\binbegrepen\b|\bcomprise?s?\b|\bcompris(?:e|es)?\b/i;
/**
 * An invoice, company or reverse-charge question: needs the actual order or
 * company registration, not the published consumer rate, so it must never
 * get the "prices include VAT" answer (baseline: "VAT invoice for my
 * company" and "VAT number ... reverse charge" both got it).
 */
const VAT_EXCLUDE = /\binvoice\b|\bfactuur\b|\bfacture\b|\bvat[- ]?number\b|\bbtw[- ]?nummer\b|num[eé]ro de tva|\breverse[- ]charge\b|\bautoliquidation\b|\bcompany\b|\bbusiness\b|\bb2b\b/i;

/** Bare "US" only as literal uppercase; lower-case "us" is the pronoun, not the country. */
const US_STRICT = /\bUS\b/;
/** Unambiguous regardless of case: no English pronoun or common word reads this way. */
const US_UNAMBIGUOUS = /\bUSA\b|\bU\.S\.A?\.?\b|\bUnited States\b/i;
const OTHER_NON_EU_COUNTRY = /\b(?:UK|U\.K\.|United Kingdom|Canada|Australia|Switzerland|Norway|Japan)\b/i;
const mentionsNonEuCountry = (message: string) => US_STRICT.test(message) || US_UNAMBIGUOUS.test(message) || OTHER_NON_EU_COUNTRY.test(message);

const SHIP_WORD = /\bship(?:ping|s|ped)?\b|\bdeliver(?:ed|ing|y|ies)?\b/i;
const OUTSIDE_EU = /\boutside (?:the )?(?:eu|europe)\b|\bnon[- ]eu\b|\binternational(?:ly)?\b/i;

/** Any EU member state named, in English, Dutch or French, so a question about shipping "to us in Germany" or "chez nous en France" is never read as a non-EU question. */
const EU_COUNTRY_NAMED =
  /\b(?:belgium|belgi[eë]|belgique|germany|duitsland|allemagne|france|frankrijk|netherlands|nederland|pays-bas|luxembourg|luxemburg|spain|spanje|espagne|italy|itali[eë]|italie|poland|polen|pologne|austria|oostenrijk|autriche|portugal|ireland|ierland|irlande|sweden|zweden|su[eè]de|denmark|denemarken|danemark|finland|finlande|greece|griekenland|gr[eè]ce|czechia|czech republic|tsjechi[eë]|r[eé]publique tch[eè]que|hungary|hongarije|hongrie|romania|roemeni[eë]|roumanie|bulgaria|bulgarije|bulgarie|croatia|kroati[eë]|croatie|slovakia|slowakije|slovaquie|slovenia|sloveni[eë]|slov[eé]nie|estonia|estland|estonie|latvia|letland|lettonie|lithuania|litouwen|lituanie|malta|malte|cyprus|chypre)\b/i;

/** A hardware spec word ("US or EU power plug", "60A continuous"): the message is asking about the product, not about where it ships. */
const PRODUCT_SPEC_WORD = /\bplug\b|\bcontinuous\b|\b\d+\s?a\b/i;

export function matchShippingVatInfo(message: string): FixedInfo | null {
  const vat = !VAT_EXCLUDE.test(message) && VAT_QUESTION.test(message) && VAT_INCLUDED_TERM.test(message);
  const nonEuShipping =
    !EU_COUNTRY_NAMED.test(message) &&
    !PRODUCT_SPEC_WORD.test(message) &&
    SHIP_WORD.test(message) &&
    (mentionsNonEuCountry(message) || OUTSIDE_EU.test(message));
  if (!vat && !nonEuShipping) return null;
  const text = vat
    ? 'Every price and shipping rate shown already includes VAT. Within the EU there are no customs formalities and no import duties after checkout.'
    : "Direct checkout only covers the EU countries offered at checkout, shipped from Belgium; VAT is included and there are no customs charges. Outside the EU, Incutec does not offer direct consumer checkout: retailers can request a bulk quote, and consumers can sign up for launch news for other countries.";
  return {
    text,
    citations: [{n: 1, title: 'Shipping and delivery', url: '/shipping', source: 'OpenDrone storefront', kind: 'doc'}],
  };
}
