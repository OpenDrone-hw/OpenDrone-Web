import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {cheapestRate, fetchShippingTable, parseZone, toGrams, type ShippingTable} from './international-shipping.ts';

/** A weight band as the Admin API returns it. */
function band(amount: string, min: number | null, max: number | null, extra: object = {}) {
  const conditions = [
    ...(min === null ? [] : [{field: 'TOTAL_WEIGHT', operator: 'GREATER_THAN_OR_EQUAL_TO', conditionCriteria: {__typename: 'Weight', value: min, unit: 'KILOGRAMS'}}]),
    ...(max === null ? [] : [{field: 'TOTAL_WEIGHT', operator: 'LESS_THAN_OR_EQUAL_TO', conditionCriteria: {__typename: 'Weight', value: max, unit: 'KILOGRAMS'}}]),
  ];
  return {active: true, rateProvider: {__typename: 'DeliveryRateDefinition', price: {amount, currencyCode: 'EUR'}}, methodConditions: conditions, ...extra};
}
function zone(countries: string[], methods: unknown[], restOfWorld = false, more = false) {
  return {
    zone: {countries: [...countries.map((c) => ({code: {countryCode: c, restOfWorld: false}})), ...(restOfWorld ? [{code: {countryCode: null, restOfWorld: true}}] : [])]},
    methodDefinitions: {pageInfo: {hasNextPage: more}, nodes: methods},
  } as Parameters<typeof parseZone>[0];
}

// The configured United Kingdom zone (Shopify admin, 2026-10-04).
const GB = zone(['GB'], [
  band('35.0', 0, 0.5), band('40.0', 0.5, 1), band('45.0', 1, 2), band('55.0', 2, 3),
  band('85.0', 3, 5), band('140.0', 5, 10), band('225.0', 10, 20), band('615.0', 20, 50), band('1220.0', 50, null),
]);
const RX = 'gid://shopify/ProductVariant/rx';
const MOTOR = 'gid://shopify/ProductVariant/motor';
const table = (zones = [parseZone(GB)]): ShippingTable => ({zones, grams: {[RX]: 200, [MOTOR]: 50}});

describe('international shipping from Shopify rates', () => {
  it('converts weights to grams', () => {
    assert.equal(toGrams({value: 0.2, unit: 'KILOGRAMS'}), 200);
    assert.equal(toGrams({value: 50, unit: 'GRAMS'}), 50);
    assert.equal(toGrams({value: 1, unit: 'POUNDS'}), 453.592);
    assert.equal(toGrams({value: 1, unit: 'STONES'}), null);
    assert.equal(toGrams(null), null);
  });

  it('charges the band that holds the cart weight, as Shopify does', () => {
    assert.equal(cheapestRate(table(), 'GB', [{merchandiseId: RX, quantity: 1}], 'EUR'), 35);
    assert.equal(cheapestRate(table(), 'GB', [{merchandiseId: RX, quantity: 2}, {merchandiseId: MOTOR, quantity: 3}], 'EUR'), 40);
    assert.equal(cheapestRate(table(), 'GB', [{merchandiseId: RX, quantity: 300}], 'EUR'), 1220);
  });

  it('takes the cheaper band on a shared edge (both bounds inclusive)', () => {
    // 2 x 200 g + 2 x 50 g = 0.5 kg: Shopify offers 35 and 40.
    assert.equal(cheapestRate(table(), 'GB', [{merchandiseId: RX, quantity: 2}, {merchandiseId: MOTOR, quantity: 2}], 'EUR'), 35);
  });

  it('gives up whenever the figure could differ from checkout', () => {
    const lines = [{merchandiseId: RX, quantity: 1}];
    assert.equal(cheapestRate(table(), 'GB', lines, 'GBP'), null, 'another currency');
    assert.equal(cheapestRate(table(), 'JP', lines, 'EUR'), null, 'no zone');
    assert.equal(cheapestRate(table(), 'GB', [{merchandiseId: 'gid://shopify/ProductVariant/x', quantity: 1}], 'EUR'), null, 'no weight');
    const carrier = zone(['GB'], [{active: true, rateProvider: {__typename: 'DeliveryParticipant'}, methodConditions: []}]);
    assert.equal(cheapestRate(table([parseZone(carrier)]), 'GB', lines, 'EUR'), null, 'carrier rate');
    const byPrice = zone(['GB'], [{...band('35.0', 0, 0.5), methodConditions: [{field: 'TOTAL_PRICE', operator: 'GREATER_THAN_OR_EQUAL_TO', conditionCriteria: {__typename: 'MoneyV2'}}]}]);
    assert.equal(cheapestRate(table([parseZone(byPrice)]), 'GB', lines, 'EUR'), null, 'price condition');
    assert.equal(cheapestRate(table([parseZone(zone(['GB'], [band('35.0', 0, 0.5)], false, true))]), 'GB', lines, 'EUR'), null, 'more methods than read');
  });

  it('ignores inactive rates and falls back to the rest-of-world zone', () => {
    const z = zone([], [band('10.0', 0, 1, {active: false}), band('50.0', 0, 1)], true);
    assert.equal(cheapestRate(table([parseZone(GB), parseZone(z)]), 'CO', [{merchandiseId: RX, quantity: 1}], 'EUR'), 50);
  });

  it('refuses a shop with more than one delivery profile', async () => {
    const fetcher = (async () => Response.json({data: {deliveryProfiles: {nodes: [
      {id: 'a', profileLocationGroups: [{locationGroup: {id: 'g'}}]},
      {id: 'b', profileLocationGroups: [{locationGroup: {id: 'g'}}]},
    ]}}})) as typeof fetch;
    await assert.rejects(
      fetchShippingTable({SHOPIFY_STORE_DOMAIN: 'shop.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 't'}, fetcher),
      /single delivery profile/,
    );
  });
});
