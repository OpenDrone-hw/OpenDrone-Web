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
 * The non-EU countries batch 1 stock ships to from Belgium now (founder
 * 2026-11-03): the buyer pays import VAT and duties on delivery. The one list
 * the allocation region (`regionOf` 'IMP', preorder-campaign.ts) and the ship
 * line (`geoAvailabilityRegion` 'import', geo-availability.ts) read. Every
 * other non-EU country is 'INT'; whether INT gets batch 1 is one data entry,
 * the paid batches' `regions` in content/preorders.json.
 */
export const IMPORT_COUNTRY_CODES: readonly string[] = ['GB', 'CH', 'NO'];
