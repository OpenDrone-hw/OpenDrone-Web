import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it, mock} from 'node:test';
import {geoAvailabilityRegion} from './geo-availability.ts';
import {PENDING_SHIP_TO_TIMEOUT_MS, getPendingShipTo, reconcilePendingShipTo, setPendingShipTo, withPendingShipTo} from './pending-ship-to.ts';
import {cartQuoteCountry} from './shipping-rates.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('pending Ship to (optimistic destination while a switch is in flight)', () => {
  it('holds the picked country until cleared', () => {
    setPendingShipTo(null);
    assert.equal(getPendingShipTo(), null);
    setPendingShipTo(' be ');
    assert.equal(getPendingShipTo(), 'BE');
    setPendingShipTo(null);
    assert.equal(getPendingShipTo(), null);
  });
  it('applies to the root geo: country and region follow, locale stays; nothing pending keeps it', () => {
    const us = {country: 'US', region: geoAvailabilityRegion('US'), locale: 'en' as const};
    assert.deepEqual(withPendingShipTo(us, 'BE', geoAvailabilityRegion), {country: 'BE', region: 'eu', locale: 'en'});
    assert.equal(withPendingShipTo(us, null, geoAvailabilityRegion), us);
    assert.equal(withPendingShipTo(us, 'US', geoAvailabilityRegion), us);
    assert.equal(withPendingShipTo(null, 'BE', geoAvailabilityRegion), null);
  });
  it('clears only once the root loader returns new data, not on the data it started from', () => {
    const before = {visitorCountry: 'US'};
    setPendingShipTo('BE', before);
    reconcilePendingShipTo(before);
    assert.equal(getPendingShipTo(), 'BE');
    reconcilePendingShipTo({visitorCountry: 'BE'});
    assert.equal(getPendingShipTo(), null);
  });
  it('a stuck switch clears after the timeout', () => {
    mock.timers.enable({apis: ['setTimeout']});
    try {
      setPendingShipTo('BE', {});
      mock.timers.tick(PENDING_SHIP_TO_TIMEOUT_MS - 1);
      assert.equal(getPendingShipTo(), 'BE');
      mock.timers.tick(1);
      assert.equal(getPendingShipTo(), null);
    } finally {
      mock.timers.reset();
    }
  });
  it('the country picker starts it before the POST from the current root data; a failed switch clears it', () => {
    const src = read('../components/CountryPicker.tsx');
    const set = src.lastIndexOf('setPendingShipTo(choice.country, root)');
    assert.ok(set > 0 && set < src.indexOf('await fetch(CART_COUNTRY_ACTION'));
    assert.match(src, /\} catch \{\s+setPendingShipTo\(null\);\s+setFailed\(true\);/);
    // Success is reconciled by the layout, not cleared in finally (no flicker back to the old country).
    assert.doesNotMatch(src, /finally \{\s+setPendingShipTo/);
    assert.match(read('../components/PageLayout.tsx'), /useEffect\(\(\) => reconcilePendingShipTo\(rootData\), \[rootData\]\)/);
  });
  it('a blocked IP country beats the picked one: in the cart gate and the bar', () => {
    assert.equal(cartQuoteCountry('BE', 'RU', null), 'RU');
    assert.equal(cartQuoteCountry('BE', 'US', null), 'BE');
    const ru = {country: 'RU', region: geoAvailabilityRegion('RU'), locale: 'en' as const};
    assert.equal(withPendingShipTo(ru, 'BE', geoAvailabilityRegion, true), ru);
    assert.match(read('../routes/cart.$.tsx'), /country=\{cartQuoteCountry\(pendingShipTo \?\? country \?\? cart\.country, rootData\?\.visitorCountry/);
    assert.match(read('../components/ShipChip.tsx'), /withPendingShipTo\(root\?\.geo, usePendingShipTo\(\), \(country\) => geoAvailabilityRegion\(country, usOpen\), ipBlocked\)/);
  });
  it('the bar, ship lines, cart gate and drawer read it; Checkout stays disabled while pending', () => {
    // Only useShipGeo reads the root loader; every ship hook goes through it.
    assert.doesNotMatch(read('../components/ShipChip.tsx'), /useRouteLoaderData<RootLoader>\('root'\)\?\.geo/);
    assert.match(read('../components/ShipChip.tsx'), /export function useShipGeo\(\)/);
    assert.match(read('../components/PageLayout.tsx'), /<AvailabilityBar\s+geo=\{shipGeo \?\? geo\}/);
    const cart = read('../routes/cart.$.tsx');
    // Cart Checkout: pending includes a switch in flight anywhere (the drawer too).
    assert.match(cart, /const switching = usePendingShipTo\(\) != null;\s+const pending = inFlight > 0 \|\| revalidator\.state !== 'idle' \|\| switching;/);
    assert.match(cart, /const blocked = pending \|\| overLimit \|\| euOnlyForUs;/);
    assert.match(cart, /onBusy=\{\(busy\) => onPending\(busy \? 1 : -1\)\}/);
    const dialog = read('../components/CartAddedDialog.tsx');
    assert.match(dialog, /const visitor = cartQuoteCountry\(pendingShipTo \?\? confirmed, confirmed,/);
    // Drawer Checkout and Add are disabled while switching.
    assert.match(dialog, /className="cart-added-checkout cart-bar-checkout"\s+disabled=\{switching\}/);
    assert.match(dialog, /disabled=\{inCart \|\| busy !== null \|\| switching\}/);
    assert.match(dialog, /if \(switching \|\| !beginCartAdd\(\)\) return;/);
  });
  it('requests never send the pending country: add, bundle and checkout send the confirmed one', () => {
    const dialog = read('../components/CartAddedDialog.tsx');
    assert.equal(dialog.match(/withCountry\([^;]*, confirmed\)/g)?.length, 2);
    assert.doesNotMatch(dialog, /withCountry\([^;]*, visitor\)/);
    assert.match(dialog, /<input type="hidden" name="country" value=\{confirmed\} \/>/);
  });
});
