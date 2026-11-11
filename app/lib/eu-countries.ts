/**
 * The 27 EU member states, the one list every module reads: the shipping
 * zones (`shipping-rates.ts`) and the visitor price note
 * (`visitor-country.ts`). Bundler-free, no imports.
 */
export const EU_COUNTRY_CODES: readonly string[] = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
];

/**
 * UK, Switzerland and Norway (founder 2026-11-03): sold with the March 2027
 * batch for now (batch 1 is EU only, `paidRegions` in content/preorders.json),
 * the buyer pays import VAT and duties on delivery. The one list
 * the allocation region (`regionOf` 'NEAR', preorder-campaign.ts) and the ship
 * line (`geoAvailabilityRegion` 'import', geo-availability.ts) read. Every
 * other non-EU country is 'INT'; whether INT gets batch 1 is one data entry,
 * `paidRegions` in content/preorders.json.
 */
export const IMPORT_COUNTRY_CODES: readonly string[] = ['GB', 'CH', 'NO'];
