/**
 * Which languages the GPSR safety warnings show in (GPSR art. 9(7) and
 * 19: the languages of the market the offer reaches). English always
 * shows, plus the official languages of the visitor's country, unfolded;
 * every other language sits in the folded disclosure. The warning lines
 * are in content/copy/product-chrome.json as gpsr_warnings_<lang> and
 * gpsr_warnings_<kind>_<lang>.
 *
 * Bundler-free (no imports) so the node:test suites can load it.
 */

/** Official languages per EU country, as the warnings are written for
 *  them. Ireland and Malta are served in English. */
export const COUNTRY_LANGUAGES: Readonly<Record<string, readonly string[]>> = {
  AT: ['de'],
  BE: ['nl', 'fr', 'de'],
  BG: ['bg'],
  HR: ['hr'],
  CY: ['el'],
  CZ: ['cs'],
  DK: ['da'],
  EE: ['et'],
  FI: ['fi', 'sv'],
  FR: ['fr'],
  DE: ['de'],
  GR: ['el'],
  HU: ['hu'],
  IE: ['en'],
  IT: ['it'],
  LV: ['lv'],
  LT: ['lt'],
  LU: ['fr', 'de'],
  MT: ['en'],
  NL: ['nl'],
  PL: ['pl'],
  PT: ['pt'],
  RO: ['ro'],
  SK: ['sk'],
  SI: ['sl'],
  ES: ['es'],
  SE: ['sv'],
};

/** Every language the warnings exist in, English first, then by code. */
export const WARNING_LANGUAGES: readonly string[] = [
  'en',
  ...[...new Set(Object.values(COUNTRY_LANGUAGES).flat())].filter((l) => l !== 'en').sort(),
];

/** `shown`: English and the visitor country's languages, in that order;
 *  `folded`: the rest. An unknown or non-EU country shows English only. */
export function warningLanguages(country: string | null): {shown: string[]; folded: string[]} {
  const local = (country && COUNTRY_LANGUAGES[country.toUpperCase()]) || [];
  const shown = ['en', ...local.filter((l) => l !== 'en')];
  return {shown, folded: WARNING_LANGUAGES.filter((l) => !shown.includes(l))};
}
