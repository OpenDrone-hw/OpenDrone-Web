import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {geoAvailabilityRegion, usOnHold, US_HOLD_COPY} from './geo-availability.ts';
import {getPendingShipTo, setPendingShipTo, withPendingShipTo} from './pending-ship-to.ts';

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
  it('ShipToSelect sets it before the POST and clears it after the loaders return or on failure', () => {
    const src = read('../components/ShipToSelect.tsx');
    const set = src.indexOf('setPendingShipTo(next)');
    assert.ok(set > 0 && set < src.indexOf('await fetch(CART_COUNTRY_ACTION'));
    assert.ok(src.indexOf('await revalidator.revalidate()') < src.indexOf('setPendingShipTo(null)'));
    assert.match(src, /\} finally \{\s+setPendingShipTo\(null\);/);
  });
  it('the bar, ship lines, cart gate and drawer read it; Checkout stays disabled while pending', () => {
    assert.match(read('../components/ShipChip.tsx'), /export function useShipGeo\(\)[\s\S]*withPendingShipTo\(geo, usePendingShipTo\(\), geoAvailabilityRegion\)/);
    // Only useShipGeo reads the root geo directly; every ship hook goes through it.
    assert.equal(read('../components/ShipChip.tsx').match(/useRouteLoaderData<RootLoader>\('root'\)\?\.geo/g)?.length, 1);
    assert.match(read('../components/PageLayout.tsx'), /<AvailabilityBar geo=\{shipGeo \?\? geo\} \/>/);
    const cart = read('../routes/cart.$.tsx');
    assert.match(cart, /country=\{pendingShipTo \?\? cartQuoteCountry\(/);
    assert.match(cart, /const blocked = pending \|\| overLimit \|\| euOnlyForUs;/);
    assert.match(cart, /onBusy=\{\(busy\) => onPending\(busy \? 1 : -1\)\}/);
    assert.match(read('../components/CartAddedDialog.tsx'), /const visitor = pendingShipTo \?\? rootData\?\.visitorCountry \?\? null;/);
  });
});

describe('US on hold: neutral no-checkout wording', () => {
  it('only a US destination while US sales are closed', () => {
    assert.equal(usOnHold('US', null), true);
    assert.equal(usOnHold('us', undefined), true);
    assert.equal(usOnHold('US', 12), false);
    for (const country of ['GB', 'AQ', 'CA', 'BE', null]) assert.equal(usOnHold(country, null), false, String(country));
  });
  it('says "Not shipping to the US yet. Shops and retailers: contact us." in every locale', () => {
    assert.deepEqual(US_HOLD_COPY.en, {line: 'Not shipping to the US yet.', trade: 'Shops and retailers:', link: 'contact us'});
    for (const copy of Object.values(US_HOLD_COPY)) for (const v of Object.values(copy)) assert.ok(v.trim());
    const note = read('../components/UsHoldNote.tsx');
    assert.match(note, /\{copy\.line\} \{copy\.trade\}\{' '\}\s+<Link prefetch="intent" to="\/wholesale"/);
  });
  it('the PDP, cart and drawer show it for the US and keep the shops/trade text for other destinations', () => {
    const pdp = read('../routes/products.$handle.tsx');
    assert.match(pdp, /notDirect === 'shops' && usOnHold\(rootData\?\.visitorCountry, usRate\) \? \(\s+<UsHoldNote/);
    assert.match(pdp, /\) : notDirect === 'shops' \? \(\s+<p className="product-buy-ship">[\s\S]{0,200}product-chrome\.buy_shops_trade/);
    const cart = read('../routes/cart.$.tsx');
    assert.match(cart, /throughShops && usOnHold\(country, usRate\) \? \(\s+<>\s+<UsHoldNote/);
    assert.match(cart, /\) : throughShops \? \([\s\S]{0,600}checkout_shops_trade/);
    const dialog = read('../components/CartAddedDialog.tsx');
    assert.match(dialog, /notDirect === 'shops' && usOnHold\(visitor, usRate\) \? \(\s+<>\s+<UsHoldNote/);
    assert.match(dialog, /\) : notDirect === 'shops' \? \([\s\S]{0,400}checkout_shops_trade/);
  });
});
