/**
 * One-click retailer approval: the Worker side of scripts/wholesale-onboard.py.
 *
 * planOnboarding() is the script's dry run (VIES, customer, tags, exemption,
 * price base, code slots, welcome mail) and only reads. approveApplication()
 * is the script's --apply: it re-plans, writes the customer, its wholesale
 * metafields and the codes, reads everything back and, when that is clean,
 * mails the retailer. It writes only while WHOLESALE_APPROVE_WRITE_ENABLED is
 * "1" and never on staging, which shares the production store.
 *
 * The price maths and the Admin helpers are those of wholesale-sync.ts (the
 * port of scripts/wholesale_lib.py); this module adds only the onboarding
 * steps. docs/wholesale.md "Onboard one retailer".
 *
 * The Admin token needs read_customers, write_customers, read_discounts and
 * write_discounts, plus read_markets for the market checks.
 */
import {sha256Hex} from './accounts/crypto.ts';
import {companyInbox, sendTradeMail, tradeConfigured, type TradeEnv} from './trade.ts';
import type {ApprovalPayload} from './wholesale-approve-token.ts';
import {
  EU_VAT, EXEMPTION, GROUPS, GroupsDoNotFit, WHOLESALE_PERCENT, adminClient, applySlot, basePriceProblem, divisor, groups,
  liveVariants, planSlot, readCode, roundingCheck, slotCode, taxPricingProblem, userErrors,
  type Admin, type ExistingCode, type Group, type SlotAction, type WholesaleEnv,
} from './wholesale-sync.ts';

export type ApproveEnv = WholesaleEnv & TradeEnv & {WHOLESALE_APPROVE_WRITE_ENABLED?: string};
export type Application = Omit<ApprovalPayload, 'v' | 'exp'>;

/** Writes only with WHOLESALE_APPROVE_WRITE_ENABLED "1" and never on staging. */
export function approveWritesEnabled(env: ApproveEnv): boolean {
  return env.WHOLESALE_APPROVE_WRITE_ENABLED?.trim() === '1' && !env.STAGING_PASSWORD?.trim();
}

const isEu = (cc: string) => cc in EU_VAT;
const META_NS = 'wholesale';

// ---------- VIES ----------

const VIES = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
/** VIES answers these when it could not ask the member state: not an answer about the number. */
const VIES_DOWN = new Set([
  'SERVICE_UNAVAILABLE', 'MS_UNAVAILABLE', 'TIMEOUT', 'GLOBAL_MAX_CONCURRENT_REQ', 'GLOBAL_MAX_CONCURRENT_REQ_TIME',
  'MS_MAX_CONCURRENT_REQ', 'MS_MAX_CONCURRENT_REQ_TIME', 'IP_BLOCKED',
]);

export type Vies =
  | {kind: 'answer'; valid: boolean; queried: string; userError: string | null; name: string | null; address: string | null; requestDate: string | null}
  | {kind: 'error'; error: string}
  | {kind: 'skipped'; skipped: string};

/** wholesale-onboard.py vies_check: only a clear isValid true counts as valid. */
export async function viesCheck(country: string, vat: string, fetcher: typeof fetch): Promise<Vies> {
  const prefix = country === 'GR' ? 'EL' : country;
  let num = vat.replace(/[\s.-]/g, '').toUpperCase();
  for (const p of [prefix, country]) {
    if (num.startsWith(p)) {
      num = num.slice(p.length);
      break;
    }
  }
  if (!/^[A-Z0-9]{1,20}$/.test(num)) return {kind: 'answer', valid: false, queried: `${prefix}${num}`, userError: 'INVALID_INPUT', name: null, address: null, requestDate: null};
  let d: {isValid?: unknown; userError?: string; name?: string; address?: string; requestDate?: string};
  try {
    const res = await fetcher(`${VIES}/${prefix}/vat/${num}`, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(30000)});
    if (!res.ok) return {kind: 'error', error: `VIES unreachable: HTTP ${res.status}`};
    d = (await res.json()) as typeof d;
  } catch {
    return {kind: 'error', error: 'VIES unreachable'};
  }
  if (d.isValid !== true && d.userError && VIES_DOWN.has(d.userError)) return {kind: 'error', error: `VIES unreachable: ${d.userError}`};
  return {
    kind: 'answer', valid: d.isValid === true, queried: `${prefix}${num}`, userError: d.userError ?? null,
    name: d.name ?? null, address: d.address ?? null, requestDate: d.requestDate ?? null,
  };
}

// ---------- plan ----------

type Customer = {id: string; email: string | null; tags: string[]; taxExemptions: string[]; note: string | null};

async function findCustomer(admin: Admin, email: string): Promise<Customer | null> {
  const d = await admin<{customers: {nodes: Customer[]}}>(
    'query($q:String!){customers(first:5,query:$q){nodes{id email tags taxExemptions note}}}',
    {q: `email:"${email.replace(/["\\]/g, '')}"`},
  );
  return d.customers.nodes.find((c) => (c.email ?? '').toLowerCase() === email.toLowerCase()) ?? null;
}

/** wholesale-onboard.py main_code: WS<percent>-<NAME>, NAME from the company (else the email's local part). */
export function mainCode(percent: number, company: string, email: string): string {
  const name = (company || email.split('@')[0]).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) || 'RETAIL';
  return `WS${String(percent).replace('.', '')}-${name}`;
}

export type MailCase = 'be' | 'reverse-charge' | 'eu-vat' | 'us' | 'non-eu';

export type SlotRow = {
  slot: number; code: string; action: SlotAction; pct: number | null; variants: string[];
  /** Worst deviation per unit and per line up to 50 units, in cents. */
  unitCents: number; lineCents: number; want: Group | null; existing: ExistingCode | null;
};

export type OnboardPlan = {
  application: Application;
  vies: Vies | null;
  exempt: boolean;
  why: string;
  /** Set: Approve writes nothing and says why. */
  refusal: string | null;
  customer: Customer | null;
  customerInput: Record<string, unknown> | null;
  metafields: Array<{key: 'vat_number' | 'company'; value: string}>;
  priceBase: string;
  divisor: number;
  main: string;
  slots: SlotRow[];
  groupCount: number;
  mailCase: MailCase;
  mail: {to: string; subject: string; text: string};
};

function mailCase(cc: string, exempt: boolean): MailCase {
  if (cc === 'BE') return 'be';
  if (exempt) return 'reverse-charge';
  if (isEu(cc)) return 'eu-vat';
  return cc === 'US' ? 'us' : 'non-eu';
}

/** The dry run (wholesale-onboard.py without --apply). Reads VIES and Shopify, never writes. */
export async function planOnboarding(admin: Admin, app: Application, {fetcher, now}: {fetcher: typeof fetch; now: Date}): Promise<OnboardPlan> {
  const email = app.email.trim().toLowerCase();
  const cc = app.country.trim().toUpperCase();
  const today = now.toISOString().slice(0, 10);
  const vies: Vies | null = app.vat ? (isEu(cc) ? await viesCheck(cc, app.vat, fetcher) : {kind: 'skipped', skipped: 'non-EU country, VIES not applicable'}) : null;
  const valid = vies?.kind === 'answer' && vies.valid;
  const exempt = valid && isEu(cc) && cc !== 'BE';
  const why = exempt ? 'VIES valid and EU country other than BE'
    : cc === 'BE' ? 'BE: Belgian retailers pay 21% VAT'
    : !isEu(cc) ? 'non-EU: export, no exemption needed'
    : !app.vat ? 'no VAT number given' : 'VIES did not confirm the number';
  const main = mainCode(WHOLESALE_PERCENT, app.company, email);
  const kind = mailCase(cc, exempt);
  const plan: OnboardPlan = {
    application: {...app, email, country: cc}, vies, exempt, why, refusal: null, customer: null, customerInput: null, metafields: [],
    priceBase: '', divisor: 1, main, slots: [], groupCount: 0, mailCase: kind,
    mail: {to: email, ...welcomeMail({...app, email, country: cc, code: main, kind, vatShown: vies?.kind === 'answer' ? vies.queried : app.vat})},
  };
  if (vies?.kind === 'error') return {...plan, refusal: `${vies.error}. Nothing written; approve again when VIES answers.`};

  const cust = await findCustomer(admin, email);
  plan.customer = cust;
  if (cust && cust.taxExemptions.includes(EXEMPTION) && !exempt) {
    // The codes would be repriced on gross retail while Shopify keeps the exemption (wholesale-onboard.py, #870).
    return {...plan, refusal: `the customer has the reverse charge exemption but this run does not confirm it (${why}). Fix the VAT number in VIES, or remove the exemption in Shopify admin first.`};
  }
  const tags = [...new Set([...(cust?.tags ?? []), 'wholesale', `country-${cc.toLowerCase()}`, ...(exempt ? ['reverse-charge'] : [])])].sort();
  const exemptions = [...new Set([...(cust?.taxExemptions ?? []), ...(exempt ? [EXEMPTION] : [])])].sort();
  const input: Record<string, unknown> = {email, tags, ...(exempt ? {taxExemptions: exemptions} : {})};
  const oldNote = (cust?.note ?? '').trim();
  const lines = oldNote ? [oldNote] : [];
  if (exempt && vies?.kind === 'answer' && !oldNote.includes(`VAT ${vies.queried} VIES valid`)) lines.push(`${today} VAT ${vies.queried} VIES valid`);
  if (app.company && !cust) lines.push(`Wholesale: ${app.company}`);
  if (lines.length !== (oldNote ? 1 : 0)) input.note = lines.join('\n');
  plan.customerInput = input;
  const vatValue = vies?.kind === 'answer' ? vies.queried : app.vat;
  plan.metafields = [
    ...(vatValue ? [{key: 'vat_number' as const, value: vatValue}] : []),
    ...(app.company ? [{key: 'company' as const, value: app.company}] : []),
  ];

  const div = divisor(cc, exempt);
  plan.divisor = div;
  const taxProblem = exempt ? await taxPricingProblem(admin) : null;
  let gs: Group[];
  try {
    gs = groups(await liveVariants(admin, cc), WHOLESALE_PERCENT, div);
  } catch (e) {
    if (e instanceof GroupsDoNotFit) return {...plan, refusal: e.message};
    throw e;
  }
  plan.groupCount = gs.length;
  const baseProblem = !isEu(cc) ? await basePriceProblem(admin) : null;
  plan.priceBase = (exempt ? `NET of ${pyPct(div)}% ${cc} VAT (reverse charge)` : `${cc} market retail`)
    + (taxProblem ? `; WARNING tax pricing: ${taxProblem}` : '')
    + (baseProblem ? `; WARNING base price: ${baseProblem}` : '');
  for (let n = 1; n <= GROUPS; n++) {
    const code = slotCode(main, n);
    const want = n <= gs.length ? gs[n - 1] : null;
    const existing = await readCode(admin, code);
    const action: SlotAction = cust ? planSlot(existing, want, [cust.id]) : want ? 'create' : 'none';
    const [unitCents, lineCents] = want ? roundingCheck(want, WHOLESALE_PERCENT, 50, div) : [0, 0];
    plan.slots.push({slot: n, code, action, pct: want?.pct ?? null, variants: want ? want.variants.map((v) => v.sku) : [], unitCents, lineCents, want, existing});
    // A code of the same name that belongs to another customer is never re-pointed to this one.
    if (existing && existing.customers.length && !(cust && existing.customers.includes(cust.id)) && !plan.refusal) {
      plan.refusal = `code ${code} already exists for another customer. Onboard by hand with --slug or --code (docs/wholesale.md).`;
    }
  }
  if (!plan.refusal && taxProblem) plan.refusal = `${taxProblem}; the net price would be discounted twice (wholesale_lib.tax_pricing_problem)`;
  if (!plan.refusal && baseProblem) plan.refusal = `${baseProblem} (wholesale_lib.base_price_problem)`;
  return plan;
}

/** Python's round((div - 1) * 100, 1) printed with str(): 21.0, 25.5. */
function pyPct(div: number): string {
  const v = Math.round((div - 1) * 1000) / 10;
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

// ---------- apply ----------

export type ReadBack = {
  customerId: string; tags: string[]; taxExemptions: string[]; note: string | null;
  vatNumber: string | null; company: string | null; slots: Array<{code: string; ok: boolean}>; ok: boolean;
};

export type ApproveResult =
  | {status: 'disabled'; plan: OnboardPlan}
  | {status: 'refused'; reason: string; plan: OnboardPlan}
  | {status: 'approved' | 'mismatch'; plan: OnboardPlan; readBack: ReadBack; mail: 'sent' | 'not_configured' | 'failed' | 'held'};

type CustomerRead = Customer & {vat: {value: string} | null; company: {value: string} | null};

async function readCustomer(admin: Admin, id: string): Promise<CustomerRead | null> {
  const d = await admin<{customer: CustomerRead | null}>(
    `query($id:ID!){customer(id:$id){id email tags taxExemptions note vat:metafield(namespace:"${META_NS}",key:"vat_number"){value} company:metafield(namespace:"${META_NS}",key:"company"){value}}}`,
    {id},
  );
  return d.customer;
}

/** wholesale-onboard.py --apply, then the welcome mail. Never throws for a refusal; throws on a Shopify error. */
export async function approveApplication(
  env: ApproveEnv,
  app: Application,
  {fetcher = fetch, now = new Date()}: {fetcher?: typeof fetch; now?: Date} = {},
): Promise<ApproveResult> {
  const admin = adminClient(env, fetcher);
  const plan = await planOnboarding(admin, app, {fetcher, now});
  if (!approveWritesEnabled(env)) return {status: 'disabled', plan};
  if (plan.refusal) return {status: 'refused', reason: plan.refusal, plan};
  const startsAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const input = plan.customerInput!;

  let cid: string;
  if (plan.customer) {
    const {email: _email, ...update} = input;
    const r = await admin<{customerUpdate: {customer: {id: string} | null; userErrors: Array<{message: string}>}}>(
      'mutation($i:CustomerInput!){customerUpdate(input:$i){customer{id} userErrors{field message}}}',
      {i: {id: plan.customer.id, ...update}},
    );
    userErrors(r.customerUpdate);
    cid = r.customerUpdate.customer!.id;
  } else {
    const r = await admin<{customerCreate: {customer: {id: string} | null; userErrors: Array<{message: string}>}}>(
      'mutation($i:CustomerInput!){customerCreate(input:$i){customer{id} userErrors{field message}}}',
      {i: input},
    );
    userErrors(r.customerCreate);
    cid = r.customerCreate.customer!.id;
  }
  if (plan.metafields.length) {
    const r = await admin<{metafieldsSet: {userErrors: Array<{message: string}>}}>(
      'mutation($m:[MetafieldsSetInput!]!){metafieldsSet(metafields:$m){metafields{key} userErrors{field message}}}',
      {m: plan.metafields.map((m) => ({ownerId: cid, namespace: META_NS, key: m.key, type: 'single_line_text_field', value: m.value}))},
    );
    userErrors(r.metafieldsSet);
  }
  const title = (n: number) => `Wholesale ${plan.application.company || plan.application.email} G${n}`;
  for (const s of plan.slots) {
    await applySlot(admin, planSlot(s.existing, s.want, [cid]), s.existing, title(s.slot), s.code, s.want, [cid], startsAt);
  }

  // By the id the write returned: the customer search index lags a new customer.
  const c = await readCustomer(admin, cid);
  const want = (key: 'vat_number' | 'company') => plan.metafields.find((m) => m.key === key)?.value ?? null;
  let ok = Boolean(c && c.tags.includes('wholesale') && c.taxExemptions.includes(EXEMPTION) === plan.exempt
    && (want('vat_number') === null || c.vat?.value === want('vat_number'))
    && (want('company') === null || c.company?.value === want('company')));
  const slots: ReadBack['slots'] = [];
  for (const s of plan.slots) {
    const got = await readCode(admin, s.code);
    const good = got || s.want ? planSlot(got, s.want, [cid]) === 'none' : true;
    slots.push({code: s.code, ok: good});
    ok = ok && good;
  }
  const readBack: ReadBack = {
    customerId: cid, tags: c?.tags ?? [], taxExemptions: c?.taxExemptions ?? [], note: c?.note ?? null,
    vatNumber: c?.vat?.value ?? null, company: c?.company?.value ?? null, slots, ok,
  };
  if (!ok) return {status: 'mismatch', plan, readBack, mail: 'held'};
  if (!tradeConfigured(env)) return {status: 'approved', plan, readBack, mail: 'not_configured'};
  const inbox = companyInbox(env);
  const sent = await sendTradeMail(env, {
    to: [plan.mail.to], replyTo: inbox, bcc: [inbox], subject: plan.mail.subject, text: plan.mail.text,
    key: `wholesale-welcome-${await sha256Hex(`${plan.mail.to}|${plan.main}`)}`,
  }, fetcher);
  return {status: 'approved', plan, readBack, mail: sent ? 'sent' : 'failed'};
}

// ---------- welcome mail ----------

const SHOP = 'https://opendrone.be';

function countryName(cc: string, lang: 'en' | 'nl'): string {
  try {
    return new Intl.DisplayNames(lang, {type: 'region'}).of(cc) ?? cc;
  } catch {
    return cc;
  }
}

/** The welcome mail, plain text, in the retailer's language (Dutch for BE and NL, English otherwise). */
export function welcomeMail(m: {
  lang: 'en' | 'nl'; kind: MailCase; email: string; contact: string; company: string; country: string; code: string; vatShown: string;
}): {subject: string; text: string} {
  const land = countryName(m.country, m.lang);
  const rate = EU_VAT[m.country];
  const company = m.company || (m.lang === 'nl' ? 'je bedrijf' : 'your company');
  if (m.lang === 'nl') {
    const vat: Record<MailCase, string> = {
      be: 'Je betaalt 21% Belgische btw, inbegrepen in de prijs.',
      'reverse-charge': `Je btw-nummer ${m.vatShown} is geldig in VIES, dus je betaalt geen btw: de btw is verlegd en je geeft ze zelf aan in ${land}. Je prijzen zijn 75% van de netto adviesprijs, de adviesprijs zonder de ${rate}% btw van ${land}. Bij het afrekenen staat er geen btw-lijn.`,
      'eu-vat': `${m.vatShown ? `We konden je btw-nummer ${m.vatShown} niet bevestigen in VIES` : 'Je gaf geen btw-nummer op'}, dus je betaalt de btw van ${land} (${rate}%), zoals bij elke bestelling naar ${land}. Stuur ons een geldig btw-nummer, dan zetten we je over naar verlegging: geen btw, aan 75% van de netto adviesprijs.`,
      us: 'Bestellingen naar de Verenigde Staten dragen geen EU-btw: je betaalt 75% van onze Amerikaanse prijs in USD, invoerrechten inbegrepen.',
      'non-eu': 'Bestellingen buiten de EU dragen geen EU-btw: je betaalt 75% van onze internationale prijs, die zonder EU-btw is. Invoerrechten en lokale belastingen zijn voor jou.',
    };
    return {
      subject: `Je OpenDrone wholesale-code: ${m.code}`,
      text: [
        `Hallo ${m.contact},`,
        '',
        `Je wholesale-account voor ${company} bij OpenDrone staat klaar. Je krijgt 25% korting op de adviesprijs van alle OpenDrone-producten, zonder minimum bestelling.`,
        '',
        `Je wholesale-code: ${m.code}`,
        '',
        'Zo bestel je',
        `1. Leg de producten in je winkelwagen op ${SHOP}.`,
        `2. Open je winkelwagen op ${SHOP}/cart en vul ${m.code} in bij Discount code. Onder elke lijn zie je de korting.`,
        `3. Meld je bij het afrekenen aan met precies dit e-mailadres: ${m.email}. Shopify mailt je een inlogcode. De code werkt alleen voor dit adres: meldt Shop Pay je aan met een ander adres, dan valt de code weg en zie je de volle prijs. Meld je dan daar af bij Shop Pay en meld je aan met ${m.email}.`,
        `4. Vul bij het afrekenen je bedrijfsnaam in (${company}) en betaal. Verzending wordt normaal aangerekend.`,
        '',
        'Wat vertrekt wanneer',
        m.kind === 'us'
          ? 'Alles vertrekt met de batch die op de productpagina staat.'
          : `FC's en ESC's die in voorraad zijn in België vertrekken binnen enkele werkdagen${m.kind === 'non-eu' ? ', per koerier' : ''}. De rest vertrekt met de batch die op de productpagina staat.`,
        "Eén bestelling vertrekt als één pakket: zit er iets in dat op een batch wacht, dan wacht de hele bestelling. Bestel de FC's en ESC's apart om ze meteen te krijgen.",
        '',
        'Btw',
        vat[m.kind],
        '',
        'Factuur',
        m.country === 'BE'
          ? 'Bij elke bestelling volgt een factuur op naam van je bedrijf, via Peppol.'
          : 'Bij elke bestelling volgt een factuur op naam van je bedrijf per e-mail.',
        '',
        'Actuele prijzen en batchdata staan op elke productpagina.',
        '',
        'Vragen? Antwoord op deze mail.',
        '',
        'OpenDrone',
      ].join('\n'),
    };
  }
  const vat: Record<MailCase, string> = {
    be: 'You pay 21% Belgian VAT, included in the price.',
    'reverse-charge': `Your VAT number ${m.vatShown} is valid in VIES, so you pay no VAT: reverse charge, you account for the VAT in ${land}. Your prices are 75% of net retail, the retail price without the ${rate}% VAT of ${land}. Checkout shows no VAT line.`,
    'eu-vat': `${m.vatShown ? `We could not confirm your VAT number ${m.vatShown} in VIES` : 'You did not give a VAT number'}, so you pay the VAT of ${land} (${rate}%), as on any order to ${land}. Send us a valid VAT number and we switch you to reverse charge: no VAT, priced at 75% of net retail.`,
    us: 'Orders to the United States carry no EU VAT: you pay 75% of our US price in USD, import duties included.',
    'non-eu': 'Orders outside the EU carry no EU VAT: you pay 75% of our International price, which is without EU VAT. Import duties and local taxes are yours.',
  };
  return {
    subject: `Your OpenDrone wholesale code: ${m.code}`,
    text: [
      `Hello ${m.contact},`,
      '',
      `Your wholesale account for ${company} at OpenDrone is ready. You get 25% off retail on all OpenDrone products, with no minimum order.`,
      '',
      `Your wholesale code: ${m.code}`,
      '',
      'How to order',
      `1. Put the products in your cart at ${SHOP}.`,
      `2. Open your cart at ${SHOP}/cart and enter ${m.code} in the Discount code field. Each line shows the discount.`,
      `3. At checkout, sign in with exactly this email address: ${m.email}. Shopify mails you a sign-in code. The code only works for this address: if Shop Pay signs you in with another address, the code drops and you see full price. Then sign out of Shop Pay there and sign in with ${m.email}.`,
      `4. Fill in your company name (${company}) at checkout and pay. Shipping is charged as usual.`,
      '',
      'What ships when',
      m.kind === 'us'
        ? 'Everything ships with the batch shown on its product page.'
        : `Flight controllers and ESCs in stock in Belgium ship within a few working days${m.kind === 'non-eu' ? ', by courier' : ''}. Everything else ships with the batch shown on its product page.`,
      'One order ships as one parcel: if it holds an item that waits for a batch, the whole order waits. Order the flight controllers and ESCs on their own to get them now.',
      '',
      'VAT',
      vat[m.kind],
      '',
      'Invoice',
      m.country === 'BE'
        ? "An invoice in your company's name follows every order, through Peppol."
        : "An invoice in your company's name follows every order by email.",
      ...(m.country === 'GB' ? ['For the invoice and the customs papers, reply with your VAT and EORI number.'] : []),
      '',
      'Prices and batch dates are on each product page.',
      '',
      'Questions? Reply to this email.',
      '',
      'OpenDrone',
    ].join('\n'),
  };
}
