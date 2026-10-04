import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {byRef, bySource, formatGroups, groupRows, orderRow, parseArgs} from '../../../scripts/attribution-report.mjs';

type Group = {key: string; orders: number; revenue: number; units: Record<string, number>};

function node(over: Record<string, unknown> = {}) {
  return {
    name: '#1001',
    createdAt: '2026-10-01T10:00:00Z',
    test: false,
    cancelledAt: null,
    displayFinancialStatus: 'PAID',
    customAttributes: [{key: '_ref', value: 'alice'}, {key: '_landing', value: '/'}],
    currentTotalPriceSet: {shopMoney: {amount: '120.50', currencyCode: 'EUR'}},
    lineItems: {pageInfo: {hasNextPage: false}, nodes: [{sku: 'OPENFC-LITE-2020', currentQuantity: 2}, {sku: 'OPENRX-LITE', currentQuantity: 0}]},
    ...over,
  };
}

describe('attribution report', () => {
  it('requires --since, refuses unknown arguments and lets --help through', () => {
    assert.throws(() => parseArgs([]), /--since/);
    assert.throws(() => parseArgs(['--since', '2026-13-45x']), /YYYY-MM-DD/);
    assert.throws(() => parseArgs(['--since', '2026-09-25', '--apply']), /unknown argument: --apply/);
    assert.equal(parseArgs(['--help']).help, true);
    assert.deepEqual(parseArgs(['--since=2026-09-25', '--orders']), {since: '2026-09-25', orders: true, help: false});
  });

  it('counts paid, live, non-test orders only, with current units', () => {
    assert.equal(orderRow(node({test: true})), null);
    assert.equal(orderRow(node({cancelledAt: '2026-10-02T00:00:00Z'})), null);
    assert.equal(orderRow(node({displayFinancialStatus: 'PENDING'})), null);
    const row = orderRow(node({displayFinancialStatus: 'PARTIALLY_REFUNDED'}));
    assert.equal(row?.ref, 'alice');
    assert.equal(row?.source, null);
    assert.deepEqual(row?.units, {'OPENFC-LITE-2020': 2});
    assert.equal(row?.revenue, 120.5);
  });

  it('groups by ref and by utm_source', () => {
    const rows = [
      orderRow(node()),
      orderRow(node({customAttributes: [{key: '_utm_source', value: 'youtube'}], currentTotalPriceSet: {shopMoney: {amount: '10', currencyCode: 'EUR'}}})),
      orderRow(node({customAttributes: [], currentTotalPriceSet: {shopMoney: {amount: '30', currencyCode: 'EUR'}}})),
      orderRow(node()),
    ];
    const refs = groupRows(rows, byRef) as Group[];
    assert.deepEqual(refs.map((g) => [g.key, g.orders]), [['alice', 2], ['(none)', 2]]);
    assert.equal(refs[0].revenue, 241);
    assert.deepEqual(refs[0].units, {'OPENFC-LITE-2020': 4});
    const sources = (groupRows(rows, bySource) as Group[]).map((g) => g.key);
    assert.deepEqual(sources, ['(ref only)', '(direct)', 'youtube']);
    assert.match(formatGroups('By ref:', refs, 'EUR'), /alice\s+2\s+241\.00\s+OPENFC-LITE-2020 x4/);
  });
});
