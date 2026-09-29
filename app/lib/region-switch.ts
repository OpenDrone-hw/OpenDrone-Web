/**
 * The EUR | USD header switch. It is a region switch: EUR puts the buyer in
 * an EU market, USD in the US market, through the same `od_ship_country`
 * pick the cart's "Ship to" select makes. Bundler-free, so node:test reads it.
 */

import {REGISTRATIONS, type RegistrationsFile} from './registrations.ts';
import {EU_COUNTRIES, shippingQuote} from './shipping-rates.ts';

export type SwitchCurrency = 'EUR' | 'USD';

/** The EU country EUR falls back to: the home market. */
export const EUR_FALLBACK_COUNTRY = 'BE';

/** The market a destination is priced in: USD for the US while US sales are
 *  open (`usRate` set), else EUR. */
export function currencyForCountry(country: string | null, usRate: number | null): SwitchCurrency {
  return usRate != null && country?.trim().toUpperCase() === 'US' ? 'USD' : 'EUR';
}

/**
 * The country the switch stores for a choice. USD is "US". EUR keeps the
 * visitor's current country when it is an EU country sold direct, else
 * Belgium (a US, non-EU, shops-only or closed-EU visitor gets the home
 * market). Null for USD while US sales are closed: nothing to switch to.
 */
export function regionSwitchCountry(
  choice: SwitchCurrency,
  current: string | null,
  usRate: number | null,
  registrations: RegistrationsFile = REGISTRATIONS,
): string | null {
  if (choice === 'USD') return usRate != null ? 'US' : null;
  const code = current?.trim().toUpperCase() ?? '';
  if (EU_COUNTRIES.has(code) && shippingQuote(code, registrations, usRate)?.kind === 'direct') return code;
  return EUR_FALLBACK_COUNTRY;
}
