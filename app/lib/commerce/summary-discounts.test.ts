import assert from 'node:assert/strict';
import {test} from 'node:test';
import {discountLabel, discountRows, lineStrike, shippingStrike} from './summary-discounts.ts';
import type {AppliedDiscount} from './app-api.ts';

const auto: AppliedDiscount = {code: null, title: 'Autumn sale', method: 'automatic', class: 'order', kind: 'fixed', value: 499, minor: 499};
const code: AppliedDiscount = {code: 'WELCOME10', title: 'Welcome', method: 'code', class: 'product', kind: 'percent', value: 10, minor: 1000};
const ship: AppliedDiscount = {code: 'SHIPFREE', title: 'Free shipping', method: 'code', class: 'shipping', kind: 'free_shipping', value: 0, minor: 695};

test('an automatic discount reads by its title, a code by the code', () => {
  assert.equal(discountLabel(auto), 'Autumn sale');
  assert.equal(discountLabel(code), 'WELCOME10');
  assert.deepEqual(
    discountRows({discounts: [auto, code]}).map((r) => [r.label, r.minor]),
    [['Autumn sale', 499], ['WELCOME10', 1000]],
  );
});

test('a shipping discount is not a minus row but strikes the shipping charge', () => {
  assert.deepEqual(discountRows({discounts: [ship]}), []);
  assert.equal(shippingStrike({discounts: [ship], shipping_minor: 0, shipping_standard_minor: 695}), 695);
  assert.equal(shippingStrike({discounts: [ship], shipping_minor: 300, shipping_standard_minor: 695}), 695);
  assert.equal(shippingStrike({discounts: [auto], shipping_minor: 0, shipping_standard_minor: 695}), null);
  assert.equal(shippingStrike({discounts: [ship], shipping_minor: 0}), null);
});

test('without discounts the single discount row is kept', () => {
  const rows = discountRows({discount: {code: 'OLD5', kind: 'fixed', value: 500, minor: 500}});
  assert.deepEqual(rows.map((r) => [r.label, r.minor]), [['Discount (OLD5)', 500]]);
  assert.deepEqual(discountRows({discount: null}), []);
  assert.deepEqual(discountRows({discount: {code: 'SHIP', kind: 'free_shipping', value: 0, minor: 0}}), []);
  assert.deepEqual(discountRows({discount: {code: 'OLD5', kind: 'fixed', value: 500, minor: 500}, discounts: []}), []);
});

test('a discounted line shows its original price struck through', () => {
  assert.deepEqual(lineStrike({total_minor: 4999, discount_minor: 499}), {was: 4999, now: 4500});
  assert.equal(lineStrike({total_minor: 4999, discount_minor: 0}), null);
  assert.equal(lineStrike({total_minor: 4999}), null);
});
