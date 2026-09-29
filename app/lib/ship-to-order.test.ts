import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {groupShipCountries} from './ship-to-order.ts';
import {EU_COUNTRIES, shipCountryPicker} from './shipping-rates.ts';

describe('groupShipCountries', () => {
  it('pins the United States after the usual five while US sales are open', () => {
    const groups = groupShipCountries(shipCountryPicker('en', 9.95));
    assert.deepEqual(groups.pinned.map((o) => o.code), ['BE', 'NL', 'DE', 'FR', 'LU', 'US']);
    assert.ok(!groups.eu.some((o) => o.code === 'US') && !groups.world.some((o) => o.code === 'US'));
  });

  it('does not pin the United States while it buys through shops', () => {
    const groups = groupShipCountries(shipCountryPicker('en', null));
    assert.deepEqual(groups.pinned.map((o) => o.code), ['BE', 'NL', 'DE', 'FR', 'LU']);
    assert.ok(groups.world.some((o) => o.code === 'US'));
  });

  it('lists the rest of the EU next, and every country once', () => {
    const picker = shipCountryPicker('en', 9.95);
    const groups = groupShipCountries(picker);
    assert.equal(groups.eu.length, EU_COUNTRIES.size - 5);
    assert.ok(groups.eu.every((o) => EU_COUNTRIES.has(o.code)));
    assert.ok(groups.world.every((o) => !EU_COUNTRIES.has(o.code)));
    assert.equal(groups.pinned.length + groups.eu.length + groups.world.length, picker.likely.length + picker.rest.length);
    const names = groups.eu.map((o) => o.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
  });
});
