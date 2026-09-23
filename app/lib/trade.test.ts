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
  isTradeSku,
  normalizeEin,
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

const US_SHOP = {
  shop: 'Rotor Riot Depot',
  site: 'rotordepot.example.com',
  country: 'US',
  taxId: '12-3456789',
  contactName: 'Sam Seller',
  email: 'buyer@rotordepot.example.com',
  sku: ['OPENFRAME-5', 'ACC-STRAP-20X220'],
  qty: ['20', '100'],
  shipTo: '100 Main St\nAustin TX 78701\nUnited States',
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
      'contactName',
      'country',
      'email',
      'lines',
      'shipTo',
      'shop',
      'website',
    ]);
  });

  it('ships to the EU27, the United Kingdom, Switzerland, Norway and the US', () => {
    assert.equal(TRADE_COUNTRIES.length, 31);
    assert.equal(TRADE_COUNTRIES.filter((c) => c.vatPrefix).length, 27);
    for (const country of ['GB', 'CH', 'RU', 'CN', 'JP', '']) {
      const r = validateTradeRequest(form({...US_SHOP, country}));
      if (['GB', 'CH'].includes(country)) continue;
      assert.equal(r.ok, false, country);
      if (!r.ok) assert.ok(r.errors.country, country);
    }
  });

  it('takes a free-text VAT or tax number outside the EU and the US', () => {
    for (const country of ['GB', 'CH', 'NO']) {
      const r = validateTradeRequest(form({...US_SHOP, country, taxId: 'GB 123 4567 89'}));
      assert.equal(r.ok, true, country);
      if (r.ok) assert.equal(r.request.taxId, 'GB 123 4567 89');
    }
    const empty = validateTradeRequest(form({...US_SHOP, country: 'CH', taxId: ' '}));
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.match(empty.errors.taxId ?? '', /Switzerland/);
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
    for (const sku of ['ACC-ANT-T', 'ACC-CAP-470UF-35V', 'x']) {
      assert.equal(isTradeSku(sku), false, sku);
      const r = validateTradeRequest(form({...EU_SHOP, sku: [sku], qty: ['10']}));
      assert.equal(r.ok, false, sku);
    }
    assert.equal(new Set(TRADE_SKUS.map((s) => s.sku)).size, TRADE_SKUS.length);
    for (const s of TRADE_SKUS) assert.ok(TRADE_GROUPS.includes(s.group), s.sku);
  });

  it('refuses receivers to a US shop, on the server', () => {
    for (const sku of ['OPENRX-LITE', 'OPENRX-LITE-UFL', 'OPENRX-MONO', 'OPENRX-GEMINI']) {
      assert.equal(tradeSkuAvailable(sku, 'US'), false, sku);
      assert.equal(tradeSkuAvailable(sku, 'DE'), true, sku);
      assert.equal(tradeSkuAvailable(sku, 'GB'), true, sku);
      const us = validateTradeRequest(form({...US_SHOP, sku: [sku], qty: ['10']}));
      assert.equal(us.ok, false, sku);
      if (!us.ok) assert.equal(us.errors.lines, 'Not available for this country');
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
    assert.equal(subject, 'Quote request: Rotor Riot Depot (US)');
    for (const part of [
      'Rotor Riot Depot',
      'https://rotordepot.example.com',
      'United States (US)',
      'EIN:',
      '12-3456789',
      'Sam Seller',
      'buyer@rotordepot.example.com',
      '20 x OPENFRAME-5',
      '100 x ACC-STRAP-20X220',
      'Austin TX 78701',
      'Note:',
      '(none)',
      'no Belgian VAT',
      '2026-09-23T10:00:00.000Z',
    ]) {
      assert.ok(text.includes(part), part);
    }
  });

  it('states the VAT treatment by destination', () => {
    assert.match(buildTradeEmail(request(EU_SHOP)).text, /VAT:\s+DE123456789[\s\S]*39bis/);
    assert.match(
      buildTradeEmail(request({...EU_SHOP, country: 'BE', taxId: 'BE0123456789'})).text,
      /Belgian VAT 21%/,
    );
    const gb = buildTradeEmail(request({...US_SHOP, country: 'GB', taxId: 'GB123456789'})).text;
    assert.match(gb, /Tax number:\s+GB123456789/);
    assert.match(gb, /no Belgian VAT/);
  });

  it('has no em dash', () => {
    assert.ok(!buildTradeEmail(request()).text.includes(String.fromCharCode(0x2014)));
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
    assert.equal(body.subject, 'Quote request: Rotor Riot Depot (US)');
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
