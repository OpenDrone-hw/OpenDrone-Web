/**
 * Incutec BV's producer (EPR) registration numbers per EU country, from
 * `content/registrations.json`, for the recycling and take-back page. Only
 * numbers that are set are listed; a country with none is left out.
 *
 * Bundler-free (no imports) so the node:test suites can load it.
 */

export type RegistrationKind = 'weee' | 'packaging' | 'idu';

/** One country's numbers: `weee` and `packaging` everywhere, `idu` in
 *  France. null until registered. */
export type CountryRegistrations = Partial<Record<RegistrationKind, string | null>>;

export type RegistrationsFile = Record<string, CountryRegistrations | string>;

export type RegistrationRow = {
  country: string;
  name: string;
  numbers: Array<{kind: RegistrationKind; value: string}>;
};

const KINDS: readonly RegistrationKind[] = ['weee', 'packaging', 'idu'];

/** The countries with at least one number, by country name in `locale`,
 *  each with its numbers in a fixed order. `$`-prefixed keys are notes. */
export function registrationRows(file: RegistrationsFile, locale = 'en'): RegistrationRow[] {
  const names = new Intl.DisplayNames([locale], {type: 'region'});
  const rows: RegistrationRow[] = [];
  for (const [country, entry] of Object.entries(file)) {
    if (country.startsWith('$') || typeof entry !== 'object' || entry === null) continue;
    const numbers = KINDS.flatMap((kind) => {
      const value = entry[kind]?.trim();
      return value ? [{kind, value}] : [];
    });
    if (numbers.length) rows.push({country, name: names.of(country) ?? country, numbers});
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, locale));
}
