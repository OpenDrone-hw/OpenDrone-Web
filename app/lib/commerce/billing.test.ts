import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {billingArgs} from './billing.ts';

const form = (o: Record<string, string>) => (n: string) => o[n] ?? '';

describe('billingArgs', () => {
  it('keeps billing the same unless the box is ticked, and still passes company and VAT number', () => {
    assert.deepEqual(billingArgs(form({company: 'Acme', vat_number: 'BE0123456789', billing_line1: 'ignored'})), {
      billing_same: true, company: 'Acme', vat_number: 'BE0123456789',
    });
    assert.deepEqual(billingArgs(form({})), {billing_same: true, company: '', vat_number: ''});
  });

  it('reads the separate billing address with its own country', () => {
    const out = billingArgs(form({billing_different: '1', billing_name: 'Acme BV', billing_line1: 'Rue 5', billing_postal_code: '1000', billing_city: 'Brussels', billing_country: 'nl'}));
    assert.equal(out.billing_same, false);
    assert.deepEqual(out.billing_address, {name: 'Acme BV', line1: 'Rue 5', line2: '', postal_code: '1000', city: 'Brussels', country: 'NL', phone: ''});
  });
});
