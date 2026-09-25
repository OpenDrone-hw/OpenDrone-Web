import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {
  addDays,
  formatDate,
  localeOf,
  maskEmail,
  parseArgs,
  renderEmail,
  selectRecipients,
} from '../../scripts/preorder-notify.mjs';
import {parseArgs as parseReleaseArgs, describePlans} from '../../scripts/release-batch.mjs';
import {isCountedOrder} from './preorder-fulfilment.ts';

const SKUS = ['OPENFC-LITE-2020', 'OPENRX-LITE'];

type Line = {sku: string; name: string; currentQuantity: number};
function order(name: string, lines: Line[], extra: Record<string, unknown> = {}) {
  return {
    id: `gid://shopify/Order/${name}`,
    name,
    test: false,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    tags: [] as string[],
    email: 'buyer@example.com',
    customerLocale: 'en',
    lineItems: {nodes: lines},
    ...extra,
  };
}

describe('preorder-notify', () => {
  it('parses a dry run and refuses a send without a new date', () => {
    const opts = parseArgs(['--kind', 'missed', '--sku', 'OPENRX-LITE', '--batch', '1', '--new-date', 'by the end of June 2027'], SKUS);
    assert.equal(opts.send, false);
    assert.equal(opts.batch, 1);
    assert.throws(() => parseArgs(['--kind', 'moved', '--sku', 'OPENRX-LITE', '--send'], SKUS), /--new-date is required/);
    assert.throws(() => parseArgs(['--kind', 'late', '--sku', 'OPENRX-LITE', '--new-date', 'x'], SKUS), /moved or missed/);
    assert.throws(() => parseArgs(['--kind', 'moved', '--sku', 'NOPE', '--new-date', 'x'], SKUS), /campaign SKU/);
    assert.throws(() => parseArgs(['--record', '1001', '--sku', 'OPENRX-LITE'], SKUS), /--choice/);
  });

  it('selects buyers of the batch with the item still to ship, once', () => {
    const rx = {sku: 'OPENRX-LITE', name: 'OpenRX Lite', currentQuantity: 2};
    const fc = {sku: 'OPENFC-LITE-2020', name: 'OpenFC Lite 20x20', currentQuantity: 1};
    const orders = [
      order('#1001', [rx]),
      order('#1002', [rx, fc]),
      order('#1003', [{...rx, currentQuantity: 0}, fc]),
      order('#1004', [rx], {tags: ['notified-missed:OPENRX-LITE:1']}),
      order('#1005', [rx], {cancelledAt: '2026-10-01T00:00:00Z'}),
      order('#1006', [rx]),
    ];
    const batchesOf = (o: {name: string}) => (o.name === '#1006' ? [2] : [1]);
    const picked = selectRecipients(orders, {sku: 'OPENRX-LITE', batch: 1, kind: 'missed', again: false, isCounted: isCountedOrder, batchesOf});
    assert.deepEqual(picked.map((r: {order: {name: string}}) => r.order.name), ['#1001', '#1002']);
    assert.equal(picked[0].others, false);
    assert.equal(picked[1].others, true);
    const again = selectRecipients(orders, {sku: 'OPENRX-LITE', batch: 1, kind: 'missed', again: true, isCounted: isCountedOrder, batchesOf});
    assert.equal(again.length, 3);
  });

  it('renders the missed-target email with both choices and the reply deadline', () => {
    const mail = renderEmail('missed', {
      order: '#1001',
      product: 'OpenRX Lite',
      qty: 2,
      newDate: 'by the end of June 2027',
      deadline: formatDate('2026-12-31', 'en'),
      replyBy: formatDate(addDays('2027-01-02', 30), 'en'),
      others: false,
      email: 'buyer@example.com',
      locale: 'en',
    });
    assert.equal(mail.to, 'buyer@example.com');
    assert.match(mail.subject, /#1001/);
    assert.match(mail.text, /31 December 2026/);
    assert.match(mail.text, /REFUND/);
    assert.match(mail.text, /WAIT: .*ships by the end of June 2027/);
    assert.match(mail.text, /by 1 February 2027/);
    assert.match(mail.text, /refund includes the shipping costs/);
    assert.doesNotMatch(mail.text, /\u2014/);
  });

  it('renders the moved email in the buyer language', () => {
    const nl = renderEmail('moved', {order: '#1002', product: 'OpenFC Lite', qty: 1, newDate: 'half november 2026', email: 'b@example.com', locale: localeOf('nl-BE')});
    assert.match(nl.subject, /nieuwe verzenddatum/);
    assert.match(nl.text, /half november 2026/);
    const fr = renderEmail('moved', {order: '#1002', product: 'OpenFC Lite', qty: 1, newDate: 'mi-novembre 2026', email: 'b@example.com', locale: localeOf('fr')});
    assert.match(fr.text, /mi-novembre 2026/);
    assert.equal(localeOf(null), 'en');
  });

  it('masks addresses in the dry run', () => {
    assert.equal(maskEmail('buyer@example.com'), 'b***@example.com');
  });
});

describe('release-batch', () => {
  it('parses the batch and the ready list', () => {
    const opts = parseReleaseArgs(['--sku', 'OPENFC-LITE-2020', '--with', 'OPENRX-LITE:1,OPENFC-LITE-2020:2'], SKUS);
    assert.deepEqual(opts, {
      sku: 'OPENFC-LITE-2020',
      batch: 1,
      with: ['batch:OPENRX-LITE:1', 'batch:OPENFC-LITE-2020:2'],
      apply: false,
    });
    assert.throws(() => parseReleaseArgs([], SKUS), /--sku is required/);
    assert.throws(() => parseReleaseArgs(['--sku', 'OPENFC-LITE-2020', '--with', 'bad'], SKUS), /SKU:N/);
  });

  it('says which orders ship and which wait', () => {
    const lines = describePlans(
      [
        {orderName: '#1001', waitsFor: []},
        {orderName: '#1002', waitsFor: ['batch:OPENRX-LITE:1']},
      ],
      {sku: 'OPENFC-LITE-2020', batch: 1},
    );
    assert.deepEqual(lines, [
      'Held orders in OPENFC-LITE-2020 batch 1: 2',
      '  ships now (1): #1001',
      '  still waits (1):',
      '    #1002 waits for batch:OPENRX-LITE:1',
    ]);
  });
});
