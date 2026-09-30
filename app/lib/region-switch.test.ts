import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {currencyForCountry, regionSwitchCountry} from './region-switch.ts';
import {shipCountryCookie} from './shipping-rates.ts';

const REGISTRATIONS = {BE: {saleApproved: true}, DE: {saleApproved: true}};
const US_RATE = 19.95;

describe('regionSwitchCountry', () => {
  it('keeps an EU country sold direct for EUR', () => {
    assert.equal(regionSwitchCountry('EUR', 'DE', US_RATE, REGISTRATIONS), 'DE');
    assert.equal(regionSwitchCountry('EUR', 'de', US_RATE, REGISTRATIONS), 'DE');
  });

  it('falls back to BE for a non-EU, US, unknown or missing country', () => {
    for (const country of ['GB', 'CH', 'NO', 'US', 'RU', 'ZZ', '', null]) {
      assert.equal(regionSwitchCountry('EUR', country, US_RATE, REGISTRATIONS), 'BE', String(country));
    }
  });

  it('falls back to BE for an EU country not open for sale', () => {
    assert.equal(regionSwitchCountry('EUR', 'FR', US_RATE, REGISTRATIONS), 'BE');
  });

  it('picks US for USD from anywhere while US sales are open', () => {
    for (const country of ['DE', 'GB', 'US', null]) {
      assert.equal(regionSwitchCountry('USD', country, US_RATE, REGISTRATIONS), 'US');
    }
  });

  it('offers no USD while US sales are closed', () => {
    assert.equal(regionSwitchCountry('USD', 'DE', null, REGISTRATIONS), null);
  });

  it('only returns countries the shared cookie accepts', () => {
    for (const choice of ['EUR', 'USD'] as const) {
      const country = regionSwitchCountry(choice, 'DE', US_RATE, REGISTRATIONS);
      assert.ok(country && shipCountryCookie(country));
    }
  });
});

describe('currencyForCountry', () => {
  it('does not label an international destination as either the EU or US shortcut', () => {
    for (const country of ['GB', 'CH', 'NO', 'CA', 'AU']) {
      assert.equal(currencyForCountry(country, US_RATE), null, country);
    }
  });
  it('reads USD only for the US while US sales are open', () => {
    assert.equal(currencyForCountry('US', US_RATE), 'USD');
    assert.equal(currencyForCountry('us', US_RATE), 'USD');
    assert.equal(currencyForCountry('US', null), 'EUR');
    assert.equal(currencyForCountry('DE', US_RATE), 'EUR');
    assert.equal(currencyForCountry(null, US_RATE), 'EUR');
  });
});
