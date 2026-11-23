import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {TRADE_COUNTRIES, onboardCommand, tradeProducts, validateTradeApplication, submitTradeApplication, type TradeApplication} from './trade.ts';

const CATALOG = {products: [
  {title: 'OpenFC Lite', variants: [{sku: 'OPENFC-LITE-3030', title: '30×30 / Buy now'}, {sku: 'OPENFC-LITE-3030', title: '30×30 / Pre-order'}, {sku: 'OPENFC-LITE-2020', title: '20×20'}]},
  {title: 'OpenESC', variants: [{sku: 'OPENESC-3030', title: '30×30'}]},
  {title: 'OpenFrame', variants: [{sku: 'OPENFRAME-5', title: 'Default Title'}]},
  {title: 'HQProp 5x4.3', variants: [{sku: 'HQ-5043', title: 'Default Title'}]},
]};
const PRODUCTS = tradeProducts(CATALOG);

const ENV = {TRADE_MAIL_ENABLED: '1', RESEND_API_KEY: 'test-key'};
const fields: Record<string, string> = {company: 'Test shop', contactName: 'Test Buyer', email: 'buyer@example.com', country: 'BE', site: 'shop.example', note: 'Interested in frames.', shopType: 'online', taxId: 'be 0123.456.789', rhythm: 'monthly', 'qty_OPENFC-LITE-3030': '20', 'qty_OPENESC-3030': '10', 'qty_OPENFC-LITE-2020': '', 'qty_OPENFRAME-5': '0'};
function form(values = fields) { const f = new FormData(); for (const [key, value] of Object.entries(values)) f.set(key, value); return f; }
function application(): TradeApplication { const result = validateTradeApplication(form(), PRODUCTS); if (!result.ok) throw new Error('Invalid fixture'); return result.application; }

describe('wholesale application validation', () => {
  it('accepts any country, including outside the EU and United States', () => {
    for (const country of ['GB', 'CH', 'PH', 'CA', 'XK', 'ph']) assert.equal(validateTradeApplication(form({...fields, country}), PRODUCTS).ok, true, country);
  });
  it('needs a quantity above zero for at least one product', () => {
    const none = validateTradeApplication(form({...fields, 'qty_OPENFC-LITE-3030': '', 'qty_OPENESC-3030': '0'}), PRODUCTS);
    assert.equal(none.ok, false);
    assert.ok(!none.ok && none.errors.quantities);
  });
  it('keeps only products with a quantity, in catalogue order', () => {
    const result = validateTradeApplication(form(), PRODUCTS);
    assert.ok(result.ok);
    assert.deepEqual(result.application.quantities, [{sku: 'OPENFC-LITE-3030', name: 'OpenFC Lite 30×30', qty: 20}, {sku: 'OPENESC-3030', name: 'OpenESC 30×30', qty: 10}]);
    assert.equal(result.application.taxId, 'BE 0123.456.789');
  });
  it('lists each OpenDrone SKU once, grouped per product, without third-party products', () => {
    assert.deepEqual(PRODUCTS.map((g) => [g.product, g.items.map((i) => i.sku)]), [
      ['OpenFC Lite', ['OPENFC-LITE-3030', 'OPENFC-LITE-2020']], ['OpenESC', ['OPENESC-3030']], ['OpenFrame', ['OPENFRAME-5']],
    ]);
    assert.equal(PRODUCTS[2].items[0].variant, '');
  });
  it('ignores a posted SKU that is not in the catalog', () => {
    const result = validateTradeApplication(form({...fields, 'qty_OPENFC-LITE-3030': '', 'qty_OPENESC-3030': '', 'qty_HQ-5043': '5', 'qty_OPENFAKE': '5'}), PRODUCTS);
    assert.equal(result.ok, false);
  });
  it('builds a shell-safe onboarding command', () => {
    const app = application();
    assert.equal(onboardCommand(app), "python3 scripts/wholesale-onboard.py --email 'buyer@example.com' --country BE --vat 'BE0123456789' --company 'Test shop'");
    assert.equal(onboardCommand({...app, company: "O'Shop; rm -rf /", taxId: ''}), "python3 scripts/wholesale-onboard.py --email 'buyer@example.com' --country BE --company 'O'\\''Shop; rm -rf /'");
  });
  it('lists every country once, named and sorted', () => {
    assert.equal(new Set(TRADE_COUNTRIES.map((c) => c.code)).size, TRADE_COUNTRIES.length);
    assert.ok(TRADE_COUNTRIES.length >= 249);
    assert.equal(TRADE_COUNTRIES.find((c) => c.code === 'CH')?.name, 'Switzerland');
    const names = TRADE_COUNTRIES.map((c) => c.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
  });
  it('accepts a physical shop without a website and without order or tax details', () => {
    assert.equal(validateTradeApplication(form({...fields, site: '', note: '', taxId: '', rhythm: ''}), PRODUCTS).ok, true);
  });
  it('rejects unsupported destinations and malformed or overlong fields', () => {
    for (const [key, value] of [['shopType', ''], ['shopType', 'warehouse'], ['rhythm', 'daily'], ['taxId', '<script>'], ['qty_OPENESC-3030', '-1'], ['qty_OPENESC-3030', '2.5'], ['qty_OPENESC-3030', '100001'], ['country', 'ZZ'], ['country', ''], ['company', 'x'], ['company', 'shop\nother'], ['contactName', ''], ['email', 'wrong'], ['note', 'x'.repeat(2001)], ['site', 'javascript:alert(1)'], ['site', 'https://user:password@shop.example']]) {
      assert.equal(validateTradeApplication(form({...fields, [key]: value}), PRODUCTS).ok, false, key);
    }
  });
});

describe('wholesale application mail', () => {
  type MailCall = {url: string; headers: Record<string, string>; body: {from: string; to: string[]; reply_to: string; subject: string; text: string}};
  function recorder(status = 200) {
    const calls: MailCall[] = [];
    const api = (async (url, init) => {
      calls.push({url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as MailCall['body']});
      return new Response('{}', {status});
    }) as typeof fetch;
    return {calls, api};
  }

  it('fails closed without the explicit switch or the Resend key', async () => {
    const never = (async () => { throw new Error('must not call Resend'); }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication({...ENV, TRADE_MAIL_ENABLED: '0'}, application(), never), {ok: false, reason: 'not_configured'});
    assert.deepEqual(await submitTradeApplication({...ENV, RESEND_API_KEY: ''}, application(), never), {ok: false, reason: 'not_configured'});
  });
  it('mails the company inbox only, with reply-to the applicant and every field', async () => {
    const {calls, api} = recorder();
    assert.deepEqual(await submitTradeApplication(ENV, application(), api), {ok: true});
    assert.equal(calls.length, 1);
    const [{url, body}] = calls;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.deepEqual(body.to, ['contact@opendrone.be']);
    assert.equal(body.reply_to, 'buyer@example.com');
    assert.equal(body.subject, 'Wholesale application: Test shop (BE, 30 units)');
    for (const part of ['Test Buyer', 'buyer@example.com', 'Belgium (BE)', 'https://shop.example/', 'Interested in frames.', 'Business: Online shop', 'VAT / tax ID: BE 0123.456.789', '20 x OpenFC Lite 30×30 (OPENFC-LITE-3030)', '10 x OpenESC 30×30 (OPENESC-3030)', 'wholesale-onboard.py', 'Order rhythm: Monthly']) assert.match(body.text, new RegExp(part.replace(/[.()]/g, '\\$&')));
  });
  it('uses one idempotency key for a repeated application', async () => {
    const {calls, api} = recorder();
    await submitTradeApplication(ENV, application(), api);
    const retry = validateTradeApplication(form({...fields, company: ' TEST   SHOP ', email: 'BUYER@EXAMPLE.COM', note: 'Updated message'}), PRODUCTS);
    assert.ok(retry.ok);
    await submitTradeApplication(ENV, retry.application, api);
    assert.match(calls[0].headers['Idempotency-Key'], /^wholesale-[0-9a-f]{64}$/);
    assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  });
  it('never confirms an application Resend rejected or did not answer', async () => {
    assert.deepEqual(await submitTradeApplication(ENV, application(), recorder(422).api), {ok: false, reason: 'unavailable'});
    const down = (async () => { throw new Error('timeout'); }) as typeof fetch;
    assert.deepEqual(await submitTradeApplication(ENV, application(), down), {ok: false, reason: 'unavailable'});
  });
});
