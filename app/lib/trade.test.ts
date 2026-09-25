import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {parseCampaignConfig} from './preorder-campaign.ts';
import {
  MAX_LINES,
  MAX_QTY,
  TRADE_COUNTRIES,
  TRADE_GROUPS,
  TRADE_SKUS,
  buildTradeEmail,
  checkVies,
  isTradeSku,
  normalizeEin,
  normalizePhone,
  normalizeVat,
  sendTradeRequest,
  tradeLeadTimes,
  tradeSkuAvailable,
  validateTradeRequest,
  type TradeRequest,
} from './trade.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/trade.test.ts

function form(values: Record<string, string | string[]>) {
  return {
    get: (name: string) => {
      const v = values[name];
      return Array.isArray(v) ? v[0] ?? null : v ?? null;
    },
    getAll: (name: string) => {
      const v = values[name];
      return v === undefined ? [] : Array.isArray(v) ? v : [v];
    },
  };
}

const US_SHOP: Record<string, string | string[]> = {
  company: 'Rotor Riot Depot LLC',
  site: 'rotordepot.example.com',
  shopType: 'both',
  country: 'US',
  taxId: '12-3456789',
  contactName: 'Sam Seller',
  email: 'buyer@rotordepot.example.com',
  phone: '+1 512 555 0100',
  sku: ['OPENFRAME-5', 'ACC-STRAP-20X220'],
  qty: ['20', '100'],
  shipTo: '100 Main St\nAustin TX 78701\nUnited States',
  billingSame: 'on',
  note: '',
};

const EU_SHOP = {...US_SHOP, country: 'DE', taxId: 'DE 123 456 789'};

describe('VAT and EIN formats', () => {
  it('accepts a VAT number with or without the prefix, spaces and dots', () => {
    assert.equal(normalizeVat('DE', 'DE123456789'), 'DE123456789');
    assert.equal(normalizeVat('DE', '123 456 789'), 'DE123456789');
    assert.equal(normalizeVat('BE', 'BE 1038.934.039'), 'BE1038934039');
    assert.equal(normalizeVat('NL', 'nl123456789b01'), 'NL123456789B01');
    assert.equal(normalizeVat('AT', 'ATU12345678'), 'ATU12345678');
    assert.equal(normalizeVat('FR', 'FRXX123456789'), 'FRXX123456789');
  });

  it('uses EL for Greece', () => {
    assert.equal(normalizeVat('GR', '123456789'), 'EL123456789');
    assert.equal(normalizeVat('GR', 'EL123456789'), 'EL123456789');
  });

  it('rejects a number in the wrong format or of another country', () => {
    assert.equal(normalizeVat('DE', 'DE12345678'), null);
    assert.equal(normalizeVat('DE', 'FR12123456789'), null);
    assert.equal(normalizeVat('BE', 'BE2038934039'), null);
    assert.equal(normalizeVat('SE', 'SE123456789012'), null);
    assert.equal(normalizeVat('US', '123456789'), null);
  });

  it('formats an EIN and rejects bad ones', () => {
    assert.equal(normalizeEin('123456789'), '12-3456789');
    assert.equal(normalizeEin('12-3456789'), '12-3456789');
    assert.equal(normalizeEin('00-3456789'), null);
    assert.equal(normalizeEin('12-345678'), null);
    assert.equal(normalizeEin('DE123456789'), null);
  });
});

describe('validateTradeRequest', () => {
  it('accepts a US shop with an EIN', () => {
    const r = validateTradeRequest(form(US_SHOP), new Date('2026-09-23T10:00:00Z'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.request.taxId, '12-3456789');
    assert.equal(r.request.website, 'https://rotordepot.example.com');
    assert.deepEqual(r.request.lines.map((l) => [l.sku, l.qty]), [
      ['OPENFRAME-5', 20],
      ['ACC-STRAP-20X220', 100],
    ]);
    assert.equal(r.request.submittedAt, '2026-09-23T10:00:00.000Z');
  });

  it('accepts an EU shop with its VAT number', () => {
    const r = validateTradeRequest(form(EU_SHOP));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.request.taxId, 'DE123456789');
  });

  it('switches the tax id rule with the country', () => {
    const usWithVat = validateTradeRequest(form({...US_SHOP, taxId: 'DE123456789'}));
    assert.equal(usWithVat.ok, false);
    if (!usWithVat.ok) assert.match(usWithVat.errors.taxId ?? '', /EIN/);
    const deWithFr = validateTradeRequest(form({...EU_SHOP, taxId: 'FR12345678901'}));
    assert.equal(deWithFr.ok, false);
    if (!deWithFr.ok) assert.match(deWithFr.errors.taxId ?? '', /DE VAT number/);
  });

  it('reports every missing required field', () => {
    const r = validateTradeRequest(form({}));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(Object.keys(r.errors).sort(), [
      'billTo',
      'company',
      'contactName',
      'country',
      'email',
      'lines',
      'phone',
      'shipTo',
      'shopType',
      'website',
    ]);
  });

  it('accepts retailer enquiries only for the EU27 and the US', () => {
    assert.equal(TRADE_COUNTRIES.length, 28);
    assert.equal(TRADE_COUNTRIES.filter((c) => c.vatPrefix).length, 27);
    for (const country of ['GB', 'CH', 'NO', 'RU', 'CN', 'JP', '']) {
      const r = validateTradeRequest(form({...US_SHOP, country}));
      assert.equal(r.ok, false, country);
      if (!r.ok) assert.ok(r.errors.country, country);
    }
  });

  it('bounds the quantity', () => {
    for (const qty of ['0', '-1', '1.5', 'ten', String(MAX_QTY + 1), '']) {
      const r = validateTradeRequest(form({...US_SHOP, sku: ['OPENFRAME-5'], qty: [qty]}));
      assert.equal(r.ok, false, `qty ${qty}`);
      if (!r.ok) assert.ok(r.errors.lines);
    }
    const max = validateTradeRequest(form({...US_SHOP, sku: ['OPENFRAME-5'], qty: [String(MAX_QTY)]}));
    assert.equal(max.ok, true);
  });

  it('quotes the whole range and nothing else', () => {
    for (const sku of [
      'OPENFC-LITE-2020', 'OPENFC-LITE-3030', 'OPENESC-2020', 'OPENESC-3030',
      'OPENRX-LITE', 'OPENRX-LITE-UFL', 'OPENRX-MONO', 'OPENRX-GEMINI',
      'OPENMOTOR-1604', 'OPENMOTOR-2207', 'OPENFRAME-3', 'OPENFRAME-5',
      'ACC-FRM-PAD', 'ACC-STRAP-15X200', 'ACC-PROP-5-HQ-J37', 'ACC-PROP-3-GF-3020',
    ]) {
      assert.equal(isTradeSku(sku), true, sku);
    }
    for (const sku of ['ACC-ANT-T', 'ACC-ANT-DUAL-T', 'ACC-CAP-470UF-35V', 'ACC-CAP-470UF-50V']) {
      assert.equal(isTradeSku(sku), true, sku);
    }
    for (const sku of ['ACC-FRM-TPU-5', 'x']) {
      assert.equal(isTradeSku(sku), false, sku);
      const r = validateTradeRequest(form({...EU_SHOP, sku: [sku], qty: ['10']}));
      assert.equal(r.ok, false, sku);
    }
    assert.equal(new Set(TRADE_SKUS.map((s) => s.sku)).size, TRADE_SKUS.length);
    for (const s of TRADE_SKUS) assert.ok(TRADE_GROUPS.includes(s.group), s.sku);
  });

  it('accepts every OpenRX variant in US and EU retailer enquiries', () => {
    for (const sku of ['OPENRX-LITE', 'OPENRX-LITE-UFL', 'OPENRX-MONO', 'OPENRX-GEMINI']) {
      assert.equal(tradeSkuAvailable(sku, 'US'), true, sku);
      assert.equal(tradeSkuAvailable(sku, 'DE'), true, sku);
      assert.equal(tradeSkuAvailable(sku, 'GB'), false, sku);
      const us = validateTradeRequest(form({...US_SHOP, sku: [sku], qty: ['10']}));
      assert.equal(us.ok, true, sku);
      if (us.ok) {
        assert.equal(us.request.lines[0].sku, sku);
        assert.match(buildTradeEmail(us.request).text, /Agree the importer, broker, product eligibility and duties before accepting an order/);
      }
      assert.equal(validateTradeRequest(form({...EU_SHOP, sku: [sku], qty: ['10']})).ok, true, sku);
    }
    assert.equal(validateTradeRequest(form({...US_SHOP, sku: ['OPENFC-LITE-3030'], qty: ['10']})).ok, true);
  });

  it('refuses a SKU twice and too many lines', () => {
    const dup = validateTradeRequest(form({...US_SHOP, sku: ['OPENFRAME-5', 'OPENFRAME-5'], qty: ['1', '2']}));
    assert.equal(dup.ok, false);
    const many = validateTradeRequest(
      form({...US_SHOP, sku: Array(MAX_LINES + 1).fill('OPENFRAME-5'), qty: Array(MAX_LINES + 1).fill('1')}),
    );
    assert.equal(many.ok, false);
  });

  it('skips empty lines', () => {
    const r = validateTradeRequest(form({...US_SHOP, sku: ['OPENFRAME-3', ''], qty: ['5', '']}));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.request.lines.length, 1);
  });
});

function request(values = US_SHOP): TradeRequest {
  const r = validateTradeRequest(form(values), new Date('2026-09-23T10:00:00Z'));
  if (!r.ok) throw new Error('fixture invalid');
  return r.request;
}

describe('buildTradeEmail', () => {
  it('carries every field', () => {
    const {subject, text} = buildTradeEmail(request());
    assert.equal(subject, 'Quote request: Rotor Riot Depot LLC (US), 120 units');
    for (const part of [
      'Rotor Riot Depot LLC',
      'https://rotordepot.example.com',
      'Online and physical shop',
      'United States (US)',
      'EIN:',
      '12-3456789',
      'Sam Seller',
      'buyer@rotordepot.example.com',
      '+1 512 555 0100',
      'OPENFRAME-5',
      'ACC-STRAP-20X220',
      'Austin TX 78701',
      'Same as ship to',
      'Note:',
      '(none)',
      'verify export evidence',
      '2026-09-23T10:00:00.000Z',
    ]) {
      assert.ok(text.includes(part), part);
    }
  });

  it('states the VAT treatment by destination', () => {
    assert.match(buildTradeEmail(request(EU_SHOP)).text, /VAT number:\s+DE123456789[\s\S]*qualifying transport evidence/);
    assert.match(
      buildTradeEmail(request({...EU_SHOP, country: 'BE', taxId: 'BE0123456789'})).text,
      /Belgian VAT 21%/,
    );
    assert.match(buildTradeEmail(request(US_SHOP)).text, /Agree the importer, broker/);
  });

  it('has no em dash', () => {
    const {text, html} = buildTradeEmail(request());
    assert.ok(!text.includes(String.fromCharCode(0x2014)));
    assert.ok(!html.includes(String.fromCharCode(0x2014)));
  });
});

describe('the fields a quote needs', () => {
  const at = new Date('2026-09-23T10:00:00Z');

  it('checks the phone number', () => {
    assert.equal(normalizePhone('+32 16 12 34 56'), '+32 16 12 34 56');
    assert.equal(normalizePhone('(512) 555-0100'), '(512) 555-0100');
    assert.equal(normalizePhone('12345'), null);
    assert.equal(normalizePhone('call me'), null);
    assert.equal(normalizePhone('+1234567890123456'), null);
  });

  it('lets a physical-only shop leave the website out, nobody else', () => {
    const physical = validateTradeRequest(form({...US_SHOP, shopType: 'physical', site: ''}), at);
    assert.equal(physical.ok, true);
    if (physical.ok) assert.equal(physical.request.website, '');
    const online = validateTradeRequest(form({...US_SHOP, shopType: 'online', site: ''}), at);
    assert.equal(online.ok, false);
    if (!online.ok) assert.ok(online.errors.website);
    const bad = validateTradeRequest(form({...US_SHOP, shopType: 'physical', site: 'not a url'}), at);
    assert.equal(bad.ok, false);
    const unknownType = validateTradeRequest(form({...US_SHOP, shopType: 'mail-order'}), at);
    assert.equal(unknownType.ok, false);
    if (!unknownType.ok) assert.ok(unknownType.errors.shopType);
  });

  it('asks for a billing address only when it differs', () => {
    const same = validateTradeRequest(form(US_SHOP), at);
    assert.equal(same.ok && same.request.billTo, null);
    const missing = validateTradeRequest(form({...US_SHOP, billingSame: '', billTo: ''}), at);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.ok(missing.errors.billTo);
    const other = validateTradeRequest(
      form({...US_SHOP, billingSame: '', billTo: 'Accounts, 1 Office Park\nDallas TX 75201'}),
      at,
    );
    assert.equal(other.ok, true);
    if (other.ok) assert.match(other.request.billTo ?? '', /Dallas/);
  });

  it('takes a delivery date from today up to two years ahead', () => {
    for (const [date, ok] of [
      ['2026-09-23', true],
      ['2027-03-01', true],
      ['2026-09-22', false],
      ['2029-01-01', false],
      ['2026-02-30', false],
      ['soon', false],
    ] as const) {
      const r = validateTradeRequest(form({...US_SHOP, deliveryBy: date}), at);
      assert.equal(r.ok, ok, date);
    }
  });

  it('keeps the optional choices to their lists', () => {
    const r = validateTradeRequest(form({...US_SHOP, volume: '1k-5k', source: 'event'}), at);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual([r.request.volume, r.request.source], ['1k-5k', 'event']);
    const none = validateTradeRequest(form(US_SHOP), at);
    if (none.ok) assert.deepEqual([none.request.volume, none.request.source, none.request.deliveryBy], [null, null, null]);
    assert.equal(validateTradeRequest(form({...US_SHOP, volume: 'lots'}), at).ok, false);
    assert.equal(validateTradeRequest(form({...US_SHOP, source: 'spam'}), at).ok, false);
  });
});

describe('checkVies', () => {
  const answer = (body: unknown, status = 200) =>
    (async (url: string) => {
      assert.match(String(url), /\/ms\/DE\/vat\/123456789$/);
      return new Response(JSON.stringify(body), {status});
    }) as typeof fetch;

  it('reads a valid, an invalid and an unreachable answer', async () => {
    assert.deepEqual(
      await checkVies('DE123456789', answer({isValid: true, userError: 'VALID', name: 'ACME GMBH', address: 'Weg 1\n10115 Berlin'})),
      {status: 'valid', name: 'ACME GMBH', address: 'Weg 1\n10115 Berlin'},
    );
    assert.deepEqual(
      await checkVies('DE123456789', answer({isValid: true, userError: 'VALID', name: '---', address: '---'})),
      {status: 'valid', name: undefined, address: undefined},
    );
    assert.deepEqual(await checkVies('DE123456789', answer({isValid: false, userError: 'INVALID'})), {status: 'invalid'});
    assert.deepEqual(
      await checkVies('DE123456789', answer({isValid: false, userError: 'MS_UNAVAILABLE'})),
      {status: 'unavailable'},
    );
    assert.deepEqual(await checkVies('DE123456789', answer({}, 500)), {status: 'unavailable'});
    const offline = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    assert.deepEqual(await checkVies('DE123456789', offline), {status: 'unavailable'});
  });
});

describe('the quote email', () => {
  const prices = {
    currency: 'EUR',
    includesVat: true,
    bySku: {'OPENFRAME-5': 60.5, 'ACC-STRAP-20X220': 6.05},
  };

  it('tables the products with list prices ex VAT and a total', () => {
    const {text, html} = buildTradeEmail(request(), prices);
    // 60.50 incl. 21% VAT is 50.00 ex VAT; 20 frames 1,000.00, 100 straps 500.00.
    assert.match(text, /20\s+OPENFRAME-5\s+50\.00\s+1,000\.00\s+OpenFrame 5" Freestyle/);
    assert.match(text, /100\s+ACC-STRAP-20X220\s+5\.00\s+500\.00/);
    assert.match(text, /Total at list\s+1,500\.00/);
    assert.match(text, /21% Belgian VAT removed/);
    assert.match(html, /<td[^>]*>OPENFRAME-5<\/td>/);
    assert.match(html, />1,500\.00</);
  });

  it('says so when there are no list prices', () => {
    const {text} = buildTradeEmail(request());
    assert.match(text, /List prices unavailable/);
    assert.match(text, /OPENFRAME-5\s+-\s+-/);
  });

  it('carries the optional fields and the VIES answer', () => {
    const req = request({
      ...EU_SHOP,
      billingSame: '',
      billTo: 'Buchhaltung\nWeg 2\n10115 Berlin',
      deliveryBy: '2026-11-15',
      volume: '5k-20k',
      source: 'referral',
      note: 'Carton of 50 frames please',
    });
    req.vies = {status: 'valid', name: 'ACME GMBH', address: 'Weg 1\n10115 Berlin'};
    const {text} = buildTradeEmail(req);
    for (const part of [
      'Buchhaltung',
      '2026-11-15',
      'EUR 5,000 to 20,000 per month',
      'Recommendation',
      'Carton of 50 frames please',
      'valid when submitted: ACME GMBH, Weg 1, 10115 Berlin',
    ]) {
      assert.ok(text.includes(part), part);
    }
    req.vies = {status: 'invalid'};
    assert.match(buildTradeEmail(req).text, /VIES:\s+NOT valid/);
  });

  it('escapes what the shop typed in the HTML', () => {
    const {html} = buildTradeEmail(request({...US_SHOP, company: '<script>x</script> & Co'}));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt; &amp; Co'));
  });
});

describe('sendTradeRequest', () => {
  const ENV = {RESEND_API_KEY: 'key', PUBLIC_COMPANY_EMAIL: 'contact@opendrone.be'};

  it('sends nothing and says so without a mail key', async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch;
    assert.deepEqual(await sendTradeRequest({}, request(), fetcher), {configured: false, sent: false});
    assert.equal(calls, 0);
  });

  it('mails the shop inbox with reply-to the shop', async () => {
    let body: Record<string, unknown> = {};
    const fetcher = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{}', {status: 200});
    }) as typeof fetch;
    assert.deepEqual(await sendTradeRequest(ENV, request(), fetcher), {configured: true, sent: true});
    assert.deepEqual(body.to, ['contact@opendrone.be']);
    assert.equal(body.reply_to, 'buyer@rotordepot.example.com');
    assert.equal(body.subject, 'Quote request: Rotor Riot Depot LLC (US), 120 units');
    assert.equal(typeof body.html, 'string');
    assert.match(String(body.text), /Rotor Riot Depot LLC/);
  });

  it('reports a provider error or a network error as not sent', async () => {
    const failing = (async () => new Response('no', {status: 500})) as typeof fetch;
    assert.deepEqual(await sendTradeRequest(ENV, request(), failing), {configured: true, sent: false});
    const offline = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    assert.deepEqual(await sendTradeRequest(ENV, request(), offline), {configured: true, sent: false});
  });
});

describe('tradeLeadTimes', () => {
  it('reads the batch dates from content/preorders.json', () => {
    const config = parseCampaignConfig(
      JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')),
    );
    const lead = tradeLeadTimes(config);
    const dated = {date: 'late October 2026', targetBy: null};
    const target = {date: '11 March 2027', targetBy: '31 December 2026'};
    assert.deepEqual(lead, {
      fc: dated,
      esc: dated,
      rx: target,
      motor: target,
      frame: target,
      strap: dated,
      prop: dated,
    });
  });

  it('follows a frame batch once it has a ship date', () => {
    const config = parseCampaignConfig({
      countFrom: '2026-09-21',
      endsOn: '2026-12-31',
      priceTiers: [{upTo: 10, off: 0.1}],
      pendingShips: 'x',
      skus: {
        'OPENFRAME-5': {batches: [{units: 250, paid: true, ships: 'ships early February 2027'}]},
        'OPENFC-LITE-2020': {batches: [{units: 250, paid: true, ships: 'ships late October 2026'}]},
      },
      shipsWith: {'ACC-STRAP-20X220': {sku: 'OPENFC-LITE-2020', batch: 1}},
    });
    assert.deepEqual(tradeLeadTimes(config).frame, {date: 'early February 2027', targetBy: null});
  });
});
