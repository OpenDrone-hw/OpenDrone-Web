import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {approveLink, applicationMail, type TradeApplication} from './trade.ts';
import {approveApplication, mainCode, planOnboarding, retailerTags, welcomeMail, type Application, type MailCase} from './wholesale-approve.ts';
import {APPROVE_PATH, signApproval, verifyApproval} from './wholesale-approve-token.ts';
import {EXEMPTION, adminClient} from './wholesale-sync.ts';

const SECRET = 'test-secret-0123456789abcdef';
const NOW = new Date('2026-11-23T10:00:00Z');
const APP = {email: 'einkauf@example.eu', country: 'DE', vat: 'DE 123.456.789', company: 'Beispiel GmbH', contact: 'Erika Example'};

describe('approval link', () => {
  it('signs and verifies the application', async () => {
    const token = (await signApproval(SECRET, APP, NOW))!;
    const r = await verifyApproval(SECRET, token, NOW);
    if (!r.ok) throw new Error('not verified');
    assert.deepEqual({...r.payload, exp: 0}, {v: 1, email: 'einkauf@example.eu', country: 'DE', vat: 'DE123456789', company: 'Beispiel GmbH', contact: 'Erika Example', exp: 0});
  });

  it('refuses unsigned, tampered, foreign and malformed links with 403', async () => {
    const token = (await signApproval(SECRET, APP, NOW))!;
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({...(JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>), company: 'Other'})).toString('base64url');
    for (const bad of [null, '', body, `${forged}.${sig}`, `${body}.${sig.slice(0, -2)}AA`, `${body}.${sig}.x`, 'a.b']) {
      assert.deepEqual(await verifyApproval(SECRET, bad, NOW), {ok: false, status: 403}, String(bad).slice(0, 20));
    }
    assert.deepEqual(await verifyApproval('another-secret-0123456789', token, NOW), {ok: false, status: 403});
    assert.deepEqual(await verifyApproval(undefined, token, NOW), {ok: false, status: 403});
    assert.equal(await signApproval(undefined, APP, NOW), null);
    assert.equal(await signApproval('short', APP, NOW), null);
  });

  it('expires after 30 days with 410', async () => {
    const token = (await signApproval(SECRET, APP, NOW))!;
    assert.ok((await verifyApproval(SECRET, token, new Date(NOW.getTime() + 29 * 86400e3))).ok);
    assert.deepEqual(await verifyApproval(SECRET, token, new Date(NOW.getTime() + 31 * 86400e3)), {ok: false, status: 410});
  });

  it('the application mail carries the link above the fallback command, and only with the secret', async () => {
    const application: TradeApplication = {
      company: 'Beispiel GmbH', contactName: 'Erika Example', email: 'einkauf@example.eu', country: {code: 'DE', name: 'Germany'},
      website: '', note: '', taxId: 'DE 123.456.789', shopType: 'online', rhythm: '', quantities: [{sku: 'OPENRX-LITE', name: 'OpenRX Lite', qty: 5}],
    };
    const link = (await approveLink({WHOLESALE_APPROVE_SECRET: SECRET}, application, 'https://opendrone.be', NOW))!;
    assert.ok(link.startsWith(`https://opendrone.be${APPROVE_PATH}?t=`));
    const v = await verifyApproval(SECRET, new URL(link).searchParams.get('t'), NOW);
    assert.ok(v.ok && v.payload.vat === 'DE123456789' && v.payload.contact === 'Erika Example');
    const text = applicationMail(application, link).text;
    assert.ok(text.indexOf(link) < text.indexOf('wholesale-onboard.py'));
    assert.match(text, /Review and approve/);
    assert.equal(await approveLink({}, application, 'https://opendrone.be', NOW), null);
    assert.doesNotMatch(applicationMail(application, null).text, /Review and approve/);
  });
});

// ---------- Shopify and VIES double ----------

type Code = {id: string; code: string; status: string; customers: string[]; pct: number; variants: string[]};
type Cust = {id: string; email: string; tags: string[]; taxExemptions: string[]; note: string; meta: Record<string, string>};

const VARIANTS = [
  {id: 'gid://v/a', sku: 'OPENFC-LITE-3030', title: 'Pre-order', price: '35.10', compareAtPrice: '39.00'},
  {id: 'gid://v/b', sku: 'OPENRX-LITE', title: '', price: '16.80', compareAtPrice: '21.00'},
  {id: 'gid://v/c', sku: 'OPENFC-LITE-3030', title: 'Buy now', price: '39.00', compareAtPrice: null},
];
const amount = (x: string | null, intl: boolean) => (x === null ? null : {amount: intl ? (Math.round((Number(x) / 1.21) * 100) / 100).toFixed(2) : x});

function world({vies = {isValid: true, userError: 'VALID'} as unknown, customer = null as Cust | null, codes = [] as Code[], inclusive = 'INCLUDES_TAXES_IN_PRICE', intlDecrease = 17.36, mailStatus = 200} = {}) {
  const mutations: string[] = [];
  const mails: Array<{headers: Record<string, string>; body: Record<string, unknown>}> = [];
  const customers: Cust[] = customer ? [customer] : [];
  const state = codes.map((c) => ({...c}));
  const fetcher = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('ec.europa.eu')) {
      if (vies === 'down') throw new Error('down');
      return new Response(JSON.stringify(vies));
    }
    if (u.includes('api.resend.com')) {
      mails.push({headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown>});
      return new Response('{}', {status: mailStatus});
    }
    const {query: q, variables: v} = JSON.parse(String(init?.body)) as {query: string; variables: Record<string, unknown>};
    const json = (data: unknown) => new Response(JSON.stringify({data}));
    if (q.startsWith('mutation')) {
      const op = /\{(\w+)\(/.exec(q)![1];
      mutations.push(op);
      const i = v.i as Record<string, unknown> & {id?: string; tags?: string[]; taxExemptions?: string[]; note?: string; code?: string};
      if (op === 'customerCreate') {
        const c: Cust = {id: `gid://shopify/Customer/${100 + customers.length}`, email: String(i.email), tags: i.tags ?? [], taxExemptions: i.taxExemptions ?? [], note: i.note ?? '', meta: {}};
        customers.push(c);
        return json({customerCreate: {customer: {id: c.id}, userErrors: []}});
      }
      if (op === 'customerUpdate') {
        const c = customers.find((x) => x.id === i.id)!;
        Object.assign(c, {tags: i.tags ?? c.tags, taxExemptions: i.taxExemptions ?? c.taxExemptions, note: i.note ?? c.note});
        return json({customerUpdate: {customer: {id: c.id}, userErrors: []}});
      }
      if (op === 'metafieldsSet') {
        for (const m of v.m as Array<{ownerId: string; key: string; value: string}>) customers.find((x) => x.id === m.ownerId)!.meta[m.key] = m.value;
        return json({metafieldsSet: {userErrors: []}});
      }
      if (op === 'discountCodeBasicCreate') {
        const g = i as unknown as {code: string; context: {customers: {add: string[]}}; customerGets: {value: {percentage: number}; items: {products: {productVariantsToAdd: string[]}}}};
        state.push({id: `gid://d/${state.length}`, code: g.code, status: 'ACTIVE', customers: g.context.customers.add, pct: g.customerGets.value.percentage, variants: g.customerGets.items.products.productVariantsToAdd});
      }
      return json({[op]: {userErrors: []}});
    }
    if (q.includes('customers(first')) return json({customers: {nodes: customers.filter((c) => q && (v.q as string).includes(c.email))}});
    if (q.includes('customer(id')) {
      const c = customers.find((x) => x.id === v.id);
      return json({customer: c ? {...c, vat: c.meta.vat_number ? {value: c.meta.vat_number} : null, company: c.meta.company ? {value: c.meta.company} : null} : null});
    }
    if (q.includes('codeDiscountNodeByCode')) {
      const c = state.find((x) => x.code === v.c);
      return json({codeDiscountNodeByCode: c ? {id: c.id, codeDiscount: {status: c.status, codes: {nodes: [{code: c.code}]}, context: {customers: c.customers.map((id) => ({id}))},
        customerGets: {value: {percentage: c.pct}, items: {productVariants: {nodes: c.variants.map((id) => ({id}))}}}}} : null});
    }
    if (q.includes('productVariants(')) {
      const intl = /country:(PH|US|CH)/.test(q);
      return json({productVariants: {nodes: VARIANTS.map((x) => ({...x, product: {status: 'ACTIVE'}, ctx: {price: amount(x.price, intl), compareAtPrice: amount(x.compareAtPrice, intl)}}))}});
    }
    if (q.includes('taxesIncluded')) return json({shop: {taxesIncluded: true}, markets: {nodes: [{name: 'Belgium', priceInclusions: {inclusiveTaxPricingStrategy: inclusive}}]}});
    if (q.includes('catalogs')) return json({markets: {nodes: [{handle: 'international', catalogs: {nodes: [{priceList: {currency: 'EUR', parent: {adjustment: {type: 'PERCENTAGE_DECREASE', value: intlDecrease}}}}]}}]}});
    throw new Error(`unexpected ${q.slice(0, 50)}`);
  }) as typeof fetch;
  return {fetcher, mutations, mails, customers, state};
}

const ENV = {SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 'token'};
const ON = {...ENV, WHOLESALE_APPROVE_WRITE_ENABLED: '1', TRADE_MAIL_ENABLED: '1', RESEND_API_KEY: 'key', PUBLIC_COMPANY_EMAIL: 'contact@example.eu'};
const app = (a: Application): Application => a;
const plan = (w: ReturnType<typeof world>, a: Application) => planOnboarding(adminClient(ENV, w.fetcher), a, {fetcher: w.fetcher, now: NOW});
const slots = (p: Awaited<ReturnType<typeof plan>>) => p.slots.map((s) => [s.code, s.action, s.pct, s.variants.join(','), s.unitCents.toFixed(2), s.lineCents.toFixed(1)]);

const DE = app({email: 'einkauf@example.eu', country: 'DE', vat: 'DE123456789', company: 'Beispiel GmbH', contact: 'Erika Example'});
const DE_CUSTOMER: Cust = {id: 'gid://shopify/Customer/7', email: 'einkauf@example.eu', tags: ['newsletter'], taxExemptions: [], note: '', meta: {}};

// Expected values: printed by `python3 scripts/wholesale-onboard.py` (dry run) against the same Shopify and VIES double.
describe('plan parity with scripts/wholesale-onboard.py', () => {
  it('BE: Belgian VAT, no exemption, new customer, gross groups', async () => {
    const w = world();
    const p = await plan(w, app({email: 'shop-be@example.eu', country: 'BE', vat: 'BE0123456789', company: 'Example BV', contact: 'Jan Example'}));
    assert.equal(p.refusal, null);
    assert.equal(p.why, 'BE: Belgian retailers pay 21% VAT');
    assert.equal(p.customer, null);
    assert.deepEqual(p.customerInput, {email: 'shop-be@example.eu', tags: ['country-be', 'wholesale'], note: 'Wholesale: Example BV'});
    assert.deepEqual(p.metafields, [{key: 'vat_number', value: 'BE0123456789'}, {key: 'company', value: 'Example BV'}]);
    assert.equal(p.priceBase, 'BE market retail');
    assert.deepEqual(slots(p), [
      ['WS25-EXAMPLEBV', 'create', 0.0625, 'OPENRX-LITE', '0.00', '0.0'],
      ['WS25-EXAMPLEBV-G2', 'create', 0.1667, 'OPENFC-LITE-3030', '0.00', '6.0'],
      ['WS25-EXAMPLEBV-G3', 'create', 0.25, 'OPENFC-LITE-3030', '0.00', '0.0'],
      ['WS25-EXAMPLEBV-G4', 'none', null, '', '0.00', '0.0'],
    ]);
    assert.equal(w.mutations.length, 0);
  });

  it('DE reverse charge: exemption, note line, net price base, existing customer', async () => {
    const w = world({customer: {...DE_CUSTOMER}});
    const p = await plan(w, DE);
    assert.equal(p.refusal, null);
    assert.equal(p.exempt, true);
    assert.equal(p.customer?.id, 'gid://shopify/Customer/7');
    assert.deepEqual(p.customerInput, {
      email: 'einkauf@example.eu', tags: ['country-de', 'newsletter', 'reverse-charge', 'wholesale'],
      taxExemptions: [EXEMPTION], note: '2026-11-23 VAT DE123456789 VIES valid',
    });
    assert.deepEqual(p.metafields, [{key: 'vat_number', value: 'DE123456789'}, {key: 'company', value: 'Beispiel GmbH'}]);
    assert.equal(p.priceBase, 'NET of 19.0% DE VAT (reverse charge)');
    assert.deepEqual(slots(p), [
      ['WS25-BEISPIELGMBH', 'create', 0.2122, 'OPENRX-LITE', '0.47', '1.5'],
      ['WS25-BEISPIELGMBH-G2', 'create', 0.2997, 'OPENFC-LITE-3030', '0.02', '3.8'],
      ['WS25-BEISPIELGMBH-G3', 'create', 0.3697, 'OPENFC-LITE-3030', '0.02', '8.8'],
      ['WS25-BEISPIELGMBH-G4', 'none', null, '', '0.00', '0.0'],
    ]);
    assert.equal(p.mailCase, 'reverse-charge');
  });

  it('DE re-approval of a customer first onboarded as BE: the old country tag goes', async () => {
    const w = world({customer: {...DE_CUSTOMER, tags: [...DE_CUSTOMER.tags, 'country-be', 'wholesale']}});
    const p = await plan(w, DE);
    assert.deepEqual((p.customerInput as {tags: string[]}).tags, ['country-de', 'newsletter', 'reverse-charge', 'wholesale']);
    assert.deepEqual(retailerTags(['country-de', 'x'], 'BE', false), ['country-be', 'wholesale', 'x']);
  });

  it('HU without a valid VAT number: no exemption, gross groups', async () => {
    const w = world({vies: {isValid: false, userError: 'INVALID'}});
    const p = await plan(w, app({email: 'bolt@example.eu', country: 'HU', vat: 'HU12345678', company: 'Pelda Kft', contact: 'Anna Example'}));
    assert.equal(p.why, 'VIES did not confirm the number');
    assert.deepEqual(p.customerInput, {email: 'bolt@example.eu', tags: ['country-hu', 'wholesale'], note: 'Wholesale: Pelda Kft'});
    assert.deepEqual(p.metafields, [{key: 'vat_number', value: 'HU12345678'}, {key: 'company', value: 'Pelda Kft'}]);
    assert.equal(p.priceBase, 'HU market retail');
    assert.deepEqual(slots(p).map((s) => s.slice(0, 3)), [['WS25-PELDAKFT', 'create', 0.0625], ['WS25-PELDAKFT-G2', 'create', 0.1667], ['WS25-PELDAKFT-G3', 'create', 0.25], ['WS25-PELDAKFT-G4', 'none', null]]);
    assert.equal(p.mailCase, 'eu-vat');
  });

  it('PH outside the EU: no VIES, International market prices', async () => {
    const w = world();
    const p = await plan(w, app({email: 'shop-ph@example.eu', country: 'PH', vat: 'PH123456', company: 'Sample Trading Inc', contact: 'Maria Example'}));
    assert.deepEqual(p.vies, {kind: 'skipped', skipped: 'non-EU country, VIES not applicable'});
    assert.equal(p.why, 'non-EU: export, no exemption needed');
    assert.deepEqual(p.customerInput, {email: 'shop-ph@example.eu', tags: ['country-ph', 'wholesale'], note: 'Wholesale: Sample Trading Inc'});
    assert.deepEqual(p.metafields, [{key: 'vat_number', value: 'PH123456'}, {key: 'company', value: 'Sample Trading Inc'}]);
    assert.equal(p.priceBase, 'PH market retail');
    assert.deepEqual(slots(p), [
      ['WS25-SAMPLETRADINGINC', 'create', 0.062, 'OPENRX-LITE', '0.00', '3.0'],
      ['WS25-SAMPLETRADINGINC-G2', 'create', 0.1668, 'OPENFC-LITE-3030', '0.25', '7.0'],
      ['WS25-SAMPLETRADINGINC-G3', 'create', 0.25, 'OPENFC-LITE-3030', '0.25', '0.5'],
      ['WS25-SAMPLETRADINGINC-G4', 'none', null, '', '0.00', '0.0'],
    ]);
    assert.equal(p.mailCase, 'non-eu');
  });

  it('names the code like main_code', () => {
    assert.equal(mainCode(25, 'Example SL', 'x@example.eu'), 'WS25-EXAMPLESL');
    assert.equal(mainCode(25, '', 'buyer.one@example.eu'), 'WS25-BUYERONE');
    assert.equal(mainCode(25, 'A very long company name GmbH', 'x@example.eu'), 'WS25-AVERYLONGCOMPANY');
    assert.equal(mainCode(25, '***', ''), 'WS25-RETAIL');
  });
});

describe('refusals', () => {
  it('VIES unreachable or a member state down: refused before any Shopify read', async () => {
    for (const vies of ['down', {isValid: false, userError: 'MS_UNAVAILABLE'}]) {
      const w = world({vies, customer: {...DE_CUSTOMER}});
      const r = await approveApplication(ON, DE, {fetcher: w.fetcher, now: NOW});
      assert.equal(r.status, 'refused');
      assert.match(r.status === 'refused' ? r.reason : '', /VIES unreachable/);
      assert.equal(r.plan.customer, null);
      assert.deepEqual([w.mutations, w.mails], [[], []]);
    }
  });

  it('an exempt customer this run does not confirm is refused (#870)', async () => {
    const w = world({vies: {isValid: false, userError: 'INVALID'}, customer: {...DE_CUSTOMER, taxExemptions: [EXEMPTION]}});
    const r = await approveApplication(ON, DE, {fetcher: w.fetcher, now: NOW});
    assert.equal(r.status, 'refused');
    assert.match(r.status === 'refused' ? r.reason : '', /reverse charge exemption but this run does not confirm it \(VIES did not confirm the number\)/);
    assert.deepEqual([w.mutations, w.mails], [[], []]);
  });

  it('dynamic tax pricing and a missing International base price are refused', async () => {
    const a = await approveApplication(ON, DE, {fetcher: world({inclusive: 'DYNAMIC'}).fetcher, now: NOW});
    assert.match(a.status === 'refused' ? a.reason : '', /discounted twice/);
    const ph = app({email: 'shop-ph@example.eu', country: 'PH', vat: '', company: 'Sample Trading Inc', contact: 'Maria Example'});
    const w = world({intlDecrease: 10});
    const b = await approveApplication(ON, ph, {fetcher: w.fetcher, now: NOW});
    assert.match(b.status === 'refused' ? b.reason : '', /base-price list/);
    assert.deepEqual(w.mutations, []);
  });

  it('a code of the same name that belongs to another customer is never re-pointed', async () => {
    const taken: Code = {id: 'gid://d/x', code: 'WS25-BEISPIELGMBH', status: 'ACTIVE', customers: ['gid://shopify/Customer/99'], pct: 0.25, variants: ['gid://v/c']};
    const w = world({customer: {...DE_CUSTOMER}, codes: [taken]});
    const r = await approveApplication(ON, DE, {fetcher: w.fetcher, now: NOW});
    assert.match(r.status === 'refused' ? r.reason : '', /already exists for another customer/);
    assert.deepEqual(w.mutations, []);
  });
});

describe('approve', () => {
  it('the review (GET) never writes, even with the switch on', async () => {
    const w = world({customer: {...DE_CUSTOMER}});
    await plan(w, DE);
    assert.deepEqual([w.mutations, w.mails], [[], []]);
  });

  it('with the switch off it plans only: no writes, no mail', async () => {
    for (const env of [{...ON, WHOLESALE_APPROVE_WRITE_ENABLED: '0'}, {...ON, STAGING_PASSWORD: 'x'}]) {
      const w = world({customer: {...DE_CUSTOMER}});
      const r = await approveApplication(env, DE, {fetcher: w.fetcher, now: NOW});
      assert.equal(r.status, 'disabled');
      assert.deepEqual([w.mutations, w.mails], [[], []]);
    }
  });

  it('writes customer, metafields and codes, reads back, mails the retailer; a second approve keeps the codes', async () => {
    const w = world({customer: {...DE_CUSTOMER}});
    const r = await approveApplication(ON, DE, {fetcher: w.fetcher, now: NOW});
    assert.equal(r.status, 'approved');
    assert.deepEqual(w.mutations, ['customerUpdate', 'metafieldsSet', 'discountCodeBasicCreate', 'discountCodeBasicCreate', 'discountCodeBasicCreate']);
    const c = w.customers[0];
    assert.deepEqual([c.tags, c.taxExemptions, c.note, c.meta], [
      ['country-de', 'newsletter', 'reverse-charge', 'wholesale'], [EXEMPTION], '2026-11-23 VAT DE123456789 VIES valid',
      {vat_number: 'DE123456789', company: 'Beispiel GmbH'},
    ]);
    assert.deepEqual(w.state.map((s) => [s.code, s.pct, s.customers]), [
      ['WS25-BEISPIELGMBH', 0.2122, [c.id]], ['WS25-BEISPIELGMBH-G2', 0.2997, [c.id]], ['WS25-BEISPIELGMBH-G3', 0.3697, [c.id]],
    ]);
    assert.ok(r.status === 'approved' && r.readBack.ok && r.mail === 'sent');
    assert.equal(w.mails.length, 1);
    const mail = w.mails[0].body;
    assert.deepEqual([mail.to, mail.reply_to, mail.bcc], [['einkauf@example.eu'], 'contact@example.eu', ['contact@example.eu']]);
    assert.equal(mail.subject, 'Your OpenDrone wholesale code: WS25-BEISPIELGMBH');
    assert.equal(typeof mail.html, 'undefined');

    const again = await approveApplication(ON, DE, {fetcher: w.fetcher, now: NOW});
    assert.equal(again.status, 'approved');
    assert.deepEqual(w.mutations.slice(5), ['customerUpdate', 'metafieldsSet']);
    assert.equal(w.state.length, 3);
    assert.equal(c.note, '2026-11-23 VAT DE123456789 VIES valid'); // the note line is not repeated
    assert.equal(w.mails[1].headers['Idempotency-Key'], w.mails[0].headers['Idempotency-Key']);
  });

  it('the welcome mail key holds its text, and a 409 for that key means it was already sent', async () => {
    const w = world({mailStatus: 409});
    const r = await approveApplication(ON, DE, {fetcher: w.fetcher, now: NOW});
    assert.ok(r.status === 'approved' && r.mail === 'sent');
    const other = world();
    await approveApplication(ON, {...DE, contact: 'Someone Else'}, {fetcher: other.fetcher, now: NOW});
    assert.notEqual(other.mails[0].headers['Idempotency-Key'], w.mails[0].headers['Idempotency-Key']);
  });

  it('a new customer is created and the codes are limited to it', async () => {
    const w = world();
    const r = await approveApplication(ON, app({email: 'shop-be@example.eu', country: 'BE', vat: 'BE0123456789', company: 'Example BV', contact: 'Jan Example'}), {fetcher: w.fetcher, now: NOW});
    assert.equal(r.status, 'approved');
    assert.equal(w.mutations[0], 'customerCreate');
    assert.ok(w.state.every((s) => s.customers[0] === w.customers[0].id));
    assert.deepEqual(w.customers[0].taxExemptions, []);
  });

  it('without Resend configured the retailer is approved and the mail is left to staff', async () => {
    const w = world({customer: {...DE_CUSTOMER}});
    const r = await approveApplication({...ON, TRADE_MAIL_ENABLED: '0'}, DE, {fetcher: w.fetcher, now: NOW});
    assert.ok(r.status === 'approved' && r.mail === 'not_configured');
    assert.equal(w.mails.length, 0);
  });
});

describe('welcome mail', () => {
  const base = {email: 'buyer@example.eu', contact: 'Sam Example', company: 'Example Shop', code: 'WS25-EXAMPLESHOP', vatShown: ''};
  const mail = (kind: MailCase, country: string, vatShown = '') => welcomeMail({...base, kind, country, vatShown});
  const common = (text: string) => {
    assert.match(text, /WS25-EXAMPLESHOP/);
    assert.match(text, /https:\/\/opendrone\.be\/cart /);
    assert.match(text, /Discount code/);
    assert.match(text, /buyer@example\.eu/);
    assert.match(text, /Shop Pay/);
    assert.doesNotMatch(text, /\u2014|\u2013/);
  };

  it('BE in English: 21% Belgian VAT, Peppol', () => {
    const {subject, text} = mail('be', 'BE');
    common(text);
    assert.equal(subject, 'Your OpenDrone wholesale code: WS25-EXAMPLESHOP');
    assert.match(text, /^Hello Sam Example,/);
    assert.match(text, /You pay 21% Belgian VAT/);
    assert.match(text, /through Peppol/);
  });

  it('NL reverse charge in English', () => {
    const {text} = mail('reverse-charge', 'NL', 'NL123456789B01');
    common(text);
    assert.match(text, /NL123456789B01 is valid in VIES, so you pay no VAT/);
    assert.match(text, /75% of net retail, the retail price without the 21% VAT of Netherlands/);
    assert.doesNotMatch(text, /Peppol/);
  });

  it('DE reverse charge in English', () => {
    const {subject, text} = mail('reverse-charge', 'DE', 'DE123456789');
    common(text);
    assert.equal(subject, 'Your OpenDrone wholesale code: WS25-EXAMPLESHOP');
    assert.match(text, /25% off retail on all OpenDrone products, with no minimum order/);
    assert.match(text, /DE123456789 is valid in VIES, so you pay no VAT: reverse charge/);
    assert.match(text, /75% of net retail, the retail price without the 19% VAT of Germany/);
    assert.match(text, /invoice in your company's name follows every order by email/);
    assert.match(text, /Fill in your company name \(Example Shop\) at checkout/);
    assert.match(text, /batch dates are on each product page/);
  });

  it('HU without a valid number pays Hungarian VAT until it sends one', () => {
    const invalid = mail('eu-vat', 'HU', 'HU12345678').text;
    assert.match(invalid, /could not confirm your VAT number HU12345678 in VIES, so you pay the VAT of Hungary \(27%\)/);
    assert.match(invalid, /Send us a valid VAT number/);
    assert.match(mail('eu-vat', 'HU').text, /You did not give a VAT number, so you pay the VAT of Hungary \(27%\)/);
  });

  it('says what ships when: in-stock boards in days (by courier outside the EU), one parcel per order, EORI for the UK', () => {
    const be = mail('be', 'BE').text;
    assert.match(be, /in stock in Belgium ship within a few working days\. /);
    assert.match(be, /One order ships as one parcel/);
    const gb = mail('non-eu', 'GB').text;
    assert.match(gb, /ship within a few working days, by courier\./);
    assert.match(gb, /One order ships as one parcel/);
    assert.match(gb, /VAT and EORI number/);
    assert.doesNotMatch(mail('non-eu', 'PH').text, /EORI/);
    const us = mail('us', 'US').text;
    assert.match(us, /Everything ships with the batch shown on its product page/);
    assert.doesNotMatch(us, /within a few working days/);
  });

  it('outside the EU: no EU VAT, duties are the buyer\'s; the US price includes duties', () => {
    const ph = mail('non-eu', 'PH').text;
    common(ph);
    assert.match(ph, /no EU VAT/);
    assert.match(ph, /Import duties and local taxes are yours/);
    assert.match(mail('us', 'US').text, /US price in USD, import duties included/);
  });

  it('the plan picks the case from the application, always in English', async () => {
    const nl = await plan(world(), app({email: 'winkel@example.eu', country: 'NL', vat: 'NL123456789B01', company: 'Voorbeeld BV', contact: 'Piet Example'}));
    assert.equal(nl.mailCase, 'reverse-charge');
    assert.match(nl.mail.text, /^Hello Piet Example,/);
    assert.match(nl.mail.text, /WS25-VOORBEELDBV/);
    const ph = await plan(world(), app({email: 'shop-ph@example.eu', country: 'PH', vat: '', company: 'Sample Trading Inc', contact: 'Maria Example'}));
    assert.match(ph.mail.text, /^Hello Maria Example,/);
  });
});
