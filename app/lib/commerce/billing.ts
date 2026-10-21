/**
 * The billing part of a checkout form: a separate billing address behind "Billing address is different", and the
 * optional company name and VAT number. Pure, so the node tests cover it. The app checks the VAT number by format
 * only (no VIES lookup) and refuses `billing_same: false` without an address.
 */
export type BillingAddress = {name: string; line1: string; line2: string; postal_code: string; city: string; country: string; phone: string};
export type BillingArgs = {billing_same: boolean; billing_address?: BillingAddress; company: string; vat_number: string};

export const BILLING_PREFIX = 'billing_';

/** Read the billing fields of the checkout form (`billing_*` names, `billing_different`, `company`, `vat_number`). */
export function billingArgs(get: (name: string) => string): BillingArgs {
  const base = {company: get('company'), vat_number: get('vat_number')};
  if (get('billing_different') !== '1') return {billing_same: true, ...base};
  const f = (k: string) => get(`${BILLING_PREFIX}${k}`);
  return {
    billing_same: false,
    billing_address: {name: f('name'), line1: f('line1'), line2: f('line2'), postal_code: f('postal_code'), city: f('city'), country: f('country').toUpperCase(), phone: ''},
    ...base,
  };
}
