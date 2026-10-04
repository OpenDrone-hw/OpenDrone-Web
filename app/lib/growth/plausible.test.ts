import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {PLAUSIBLE_SNIPPET, initPlausible, plausibleRevenue, trackEvent} from './plausible.ts';
import {trackCheckoutClick} from './checkout-beacon.ts';

type Fake = {plausible?: ((...args: unknown[]) => void) & Record<string, unknown>};

const store = new Map<string, string>();
const fakeWindow = {
  location: {search: '?ref=alice-fpv', pathname: '/products/openfc'},
  sessionStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
} as unknown as Fake & Record<string, unknown>;
(globalThis as unknown as {window: unknown}).window = fakeWindow;

/** The queued calls, as the site script would replay them. */
function queue(): unknown[][] {
  return ((fakeWindow.plausible as unknown as {q?: unknown[][]})?.q ?? []).map((args) => Array.from(args));
}

describe('plausibleRevenue', () => {
  it('turns a Shopify money string into a number in major units', () => {
    assert.deepEqual(plausibleRevenue({amount: '58.40', currencyCode: 'EUR'}), {currency: 'EUR', amount: 58.4});
    assert.deepEqual(plausibleRevenue({amount: '2.10', currencyCode: 'eur'}, 3), {currency: 'EUR', amount: 6.3});
    assert.deepEqual(plausibleRevenue({amount: 12, currency: 'USD'}), {currency: 'USD', amount: 12});
  });

  it('drops a missing, zero or malformed value instead of recording 0', () => {
    assert.equal(plausibleRevenue(null), undefined);
    assert.equal(plausibleRevenue({amount: '0.0', currencyCode: 'EUR'}), undefined);
    assert.equal(plausibleRevenue({amount: '', currencyCode: 'EUR'}), undefined);
    assert.equal(plausibleRevenue({amount: 'abc', currencyCode: 'EUR'}), undefined);
    assert.equal(plausibleRevenue({amount: '5', currencyCode: ''}), undefined);
  });
});

describe('Plausible client', () => {
  beforeEach(() => {
    delete fakeWindow.plausible;
  });

  it('queues events on a stub that matches the documented snippet', () => {
    trackEvent('PDP View', {props: {product: 'openfc'}});
    assert.equal(typeof fakeWindow.plausible?.init, 'function');
    assert.deepEqual(queue(), [['PDP View', {props: {product: 'openfc'}}]]);
    // The inline snippet leaves an existing stub alone.
    new Function('window', 'plausible', PLAUSIBLE_SNIPPET)(fakeWindow, fakeWindow.plausible);
    assert.equal(queue().length, 1);
  });

  it('sends the cart subtotal as Checkout Click revenue, with the entry point', () => {
    trackCheckoutClick({amount: '58.40', currencyCode: 'EUR'}, 'dialog');
    trackCheckoutClick({amount: '58.40', currencyCode: 'EUR'}, 'cart');
    assert.deepEqual(queue(), [
      ['Checkout Click', {props: {source: 'other', ref: 'alice-fpv', entry: 'dialog'}, revenue: {currency: 'EUR', amount: 58.4}}],
      ['Checkout Click', {props: {source: 'other', ref: 'alice-fpv', entry: 'cart'}, revenue: {currency: 'EUR', amount: 58.4}}],
    ]);
  });

  it('sends Checkout Click without revenue when the subtotal is missing or zero', () => {
    trackCheckoutClick({amount: '0.0', currencyCode: 'EUR'}, 'cart');
    trackCheckoutClick(null, 'dialog');
    assert.deepEqual(
      queue().map(([, opts]) => opts),
      [{props: {source: 'other', ref: 'alice-fpv', entry: 'cart'}}, {props: {source: 'other', ref: 'alice-fpv', entry: 'dialog'}}],
    );
  });

  it('inits once with the first-touch props for every event, pageviews included', () => {
    new Function('window', 'plausible', PLAUSIBLE_SNIPPET.replace(/plausible\./g, 'window.plausible.'))(fakeWindow);
    initPlausible();
    const options = fakeWindow.plausible?.o as {customProperties: (name: string) => unknown};
    assert.deepEqual(options.customProperties('pageview'), {source: 'other', ref: 'alice-fpv'});
    assert.deepEqual(Object.keys(options), ['customProperties']);
    initPlausible();
    assert.equal(fakeWindow.plausible?.o, options);
  });
});
