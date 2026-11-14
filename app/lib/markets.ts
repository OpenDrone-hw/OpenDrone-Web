/**
 * The /markets table ("Where we ship"), generated from the data the site
 * already sells with: the region resolver (`regionFor`: market, currency,
 * taxes, lanes), the shipping zones and the pre-order ship-by day. No row is
 * written by hand: change a market in region.ts or a rate in
 * shipping-rates.ts and the page follows. A snapshot test holds the result.
 *
 * Bundler-free (relative imports) so the node:test suites can load it.
 */

import {COUNTRY_NAMES_EN} from './country-names.ts';
import {EU_COUNTRY_CODES, IMPORT_COUNTRY_CODES} from './eu-countries.ts';
import {shipByDate} from './geo-availability.ts';
import {regionFor, type MarketId, type Region, type TaxShown} from './region.ts';
import type {RegistrationsFile} from './registrations.ts';
import {SHIPPING_ZONES, countryName} from './shipping-rates.ts';

export type MarketRow = {
  market: MarketId;
  who: string;
  currency: string;
  includes: string;
  inStock: string;
  preorder: string;
  shipping: string;
};

const TAXES: Record<TaxShown, string> = {
  'eu-vat-included': 'VAT included',
  'us-duties-included': 'Duties included',
  'import-on-delivery': 'Base price, no EU VAT; import taxes on delivery',
};

const ORDER: MarketId[] = ['eu', 'us', 'import', 'world', 'none'];

const euro = (n: number) => `€${n.toFixed(2)}`;

/** Every country code the site knows, by market. */
function countriesByMarket(usOpen: boolean, registrations?: RegistrationsFile): Map<MarketId, Region[]> {
  const out = new Map<MarketId, Region[]>();
  for (const code of Object.keys(COUNTRY_NAMES_EN)) {
    const region = regionFor(code, 'choice', usOpen, registrations);
    out.set(region.market, [...(out.get(region.market) ?? []), region]);
  }
  return out;
}

/** "Belgium, the Netherlands and Germany" style list. */
function list(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * One row per market, in a fixed order: EU, United States (only while US
 * sales are open), United Kingdom, Switzerland and Norway, Rest of the world,
 * and the countries not served yet. `usRate` is the open US flat rate
 * (`usSalesRate`), null while the US is closed. `ordinary`: batch 2 has
 * landed and nothing is pre-order: stock ships to every market Incutec ships
 * to (founder 2026-11-11), so no row names a pre-order.
 */
export function marketRows(usRate: number | null, ordinary = false, registrations?: RegistrationsFile): MarketRow[] {
  const usOpen = usRate != null;
  const byMarket = countriesByMarket(usOpen, registrations);
  const shipBy = ordinary ? 'ships from stock' : `pre-orders ship by ${shipByDate('en')}`;
  const euRates = SHIPPING_ZONES.map((z) => z.rate);
  const rows: MarketRow[] = [];
  for (const market of ORDER) {
    const regions = byMarket.get(market) ?? [];
    if (!regions.length) continue;
    const sample = regions[0];
    const yes = (on: boolean) => (on ? 'Yes' : 'No');
    if (market === 'none') {
      rows.push({market, who: `Countries not served yet (${regions.length})`, currency: '-', includes: '-', inStock: 'No', preorder: 'No', shipping: 'Not yet'});
      continue;
    }
    const who =
      market === 'eu'
        ? `EU countries (${regions.length === EU_COUNTRY_CODES.length ? regions.length : `${regions.length} of ${EU_COUNTRY_CODES.length}`})`
        : market === 'us'
          ? 'United States'
          : market === 'import'
            ? list(IMPORT_COUNTRY_CODES.filter((c) => regions.some((r) => r.country === c)).map((c) => countryName(c)))
            : `Rest of the world (${regions.length} countries)`;
    const shipping =
      market === 'eu'
        ? `From Belgium, ${euro(Math.min(...euRates))} to ${euro(Math.max(...euRates))}; ${ordinary ? 'in stock ships in days' : `in stock ships in days, ${shipBy}`}`
        : market === 'us'
          ? `Flat US$${usRate!.toFixed(2)}; ${shipBy}`
          : `From Belgium, rate at checkout; ${shipBy}`;
    rows.push({
      market,
      who,
      currency: sample.currency,
      includes: TAXES[sample.taxes],
      inStock: yes(ordinary || sample.lanes.buyNow),
      preorder: yes(!ordinary && sample.lanes.preorder),
      shipping,
    });
  }
  return rows;
}

/** The column headings, in the row's key order. */
export const MARKET_COLUMNS: Array<[keyof Omit<MarketRow, 'market'>, string]> = [
  ['who', 'Who'],
  ['currency', 'Currency'],
  ['includes', 'Price includes'],
  ['inStock', 'In-stock boards'],
  ['preorder', 'Pre-orders'],
  ['shipping', 'Shipping'],
];
