/**
 * The EUR | USD header switch. It is a region switch: EUR puts the buyer in
 * an EU market, USD in the US market, through the same `od_ship_country`
 * pick the cart's "Ship to" select makes. Bundler-free, so node:test reads it.
 */

import {REGISTRATIONS, type RegistrationsFile} from './registrations.ts';
import {EU_COUNTRIES, isInternationalQuote, shippingQuote} from './shipping-rates.ts';

export type SwitchCurrency = 'EUR' | 'USD';

/** The EU country EUR falls back to: the home market. */
export const EUR_FALLBACK_COUNTRY = 'BE';

/** Which existing shortcut is active. An international destination uses
 *  Shopify's country currency, so neither the EU nor US shortcut is active. */
export function currencyForCountry(country: string | null, usRate: number | null): SwitchCurrency | null {
  if (isInternationalQuote(shippingQuote(country, undefined, usRate))) return null;
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
