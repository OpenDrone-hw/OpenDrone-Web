/**
 * The country picker's pure half: what the pill reads, the searchable list,
 * and what a choice does to the region. The component is
 * `app/components/CountryPicker.tsx`, the one control for the header, the
 * phone drawer, the cart and the added-to-cart dialog. A choice is a country;
 * the market follows from `regionFor` (region.ts), never from the picker.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import {regionFor, type Region} from './region.ts';
import {shipCountryPicker, type ShipCountryOption} from './shipping-rates.ts';
import {groupShipCountries} from './ship-to-order.ts';

/** The event a "choose your country" link sends: the visible picker opens. */
export const OPEN_COUNTRY_PICKER_EVENT = 'od:open-country-picker';

/** Where "How prices and shipping work" goes. */
export const MARKETS_PATH = '/markets';

/** The pill: "BE · EUR"; with no known country, "Country · EUR". */
export function pickerLabel(region: Pick<Region, 'country' | 'currency'>): string {
  return `${region.country ?? 'Country'} · ${region.currency}`;
}

export type PickerGroup = {id: 'pinned' | 'eu' | 'world'; label: string; options: ShipCountryOption[]};

/** The list in its three groups: most orders, the European Union, other countries. */
export function pickerGroups(
  usRate: number | null,
  labels: Record<PickerGroup['id'], string> = {pinned: 'Most orders', eu: 'European Union', world: 'Other countries'},
): PickerGroup[] {
  const groups = groupShipCountries(shipCountryPicker('en', usRate));
  return (['pinned', 'eu', 'world'] as const).map((id) => ({id, label: labels[id], options: groups[id]}));
}

/** Lower case, accents dropped: "Österreich" matches "osterreich". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * The groups that match a search: a name that starts with the query, a word
 * of the name that starts with it, or the two-letter code. Empty groups drop.
 * An empty query keeps every group.
 */
export function filterGroups(groups: PickerGroup[], query: string): PickerGroup[] {
  const q = fold(query);
  if (!q) return groups;
  const hit = (o: ShipCountryOption) => {
    const name = fold(o.name);
    return name.startsWith(q) || name.split(/[\s,()-]+/).some((w) => w.startsWith(q)) || o.code.toLowerCase() === q;
  };
  return groups.map((g) => ({...g, options: g.options.filter(hit)})).filter((g) => g.options.length > 0);
}

/** The options in list order, for arrow keys. */
export function flatOptions(groups: PickerGroup[]): ShipCountryOption[] {
  return groups.flatMap((g) => g.options);
}

/**
 * A choice: the country to post and the region it resolves to (the same
 * `regionFor` the server runs), or null when nothing changes.
 */
export function chooseCountry(
  current: string | null,
  next: string,
  usOpen: boolean,
): {country: string; region: Region} | null {
  const code = next.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === current) return null;
  return {country: code, region: regionFor(code, 'choice', usOpen)};
}
