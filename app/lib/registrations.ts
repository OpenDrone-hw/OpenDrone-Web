/**
 * Producer numbers and reviewed consumer destination approval share the
 * committed registrations file. Numbers alone never open a country.
 * Vite and node:test read the same data.
 */

export type RegistrationKind = 'weee' | 'packaging' | 'idu';

/** One country's numbers: `weee` and `packaging` everywhere, `idu` in
 *  France, null until registered; `offerNeedsNumber` where the law wants
 *  a number on the offer before selling. */
export type CountryRegistrations = Partial<Record<RegistrationKind, string | null>> & {
  /** Explicit reviewed launch approval. Missing or false always closes sales. */
  saleApproved?: boolean;
  offerNeedsNumber?: boolean;
};

export type RegistrationsFile = Record<string, CountryRegistrations | string>;

export type RegistrationNumber = {kind: RegistrationKind; value: string};

export type RegistrationRow = {
  country: string;
  name: string;
  numbers: RegistrationNumber[];
};

const KINDS: readonly RegistrationKind[] = ['weee', 'packaging', 'idu'];

function loadRegistrations(): RegistrationsFile {
  if (import.meta.env) {
    const files = import.meta.glob<{default: RegistrationsFile}>('/content/registrations.json', {eager: true});
    return Object.values(files)[0]?.default ?? {};
  }
  // node:test: no bundler, read the same file.
  const fs = (
    globalThis as {process?: {getBuiltinModule?: (id: string) => unknown}}
  ).process?.getBuiltinModule?.('node:fs') as {readFileSync: (url: URL, encoding: string) => string} | undefined;
  return fs ? (JSON.parse(fs.readFileSync(new URL('../../content/registrations.json', import.meta.url), 'utf8')) as RegistrationsFile) : {};
}

/** The registrations as committed. */
export const REGISTRATIONS: RegistrationsFile = loadRegistrations();

function entryOf(file: RegistrationsFile, country: string): CountryRegistrations | null {
  const entry = file[country];
  return typeof entry === 'object' && entry !== null ? entry : null;
}

/** The number a country requires on the offer: the IDU in France, the
 *  WEEE number elsewhere. */
function requiredKind(country: string): RegistrationKind {
  return country === 'FR' ? 'idu' : 'weee';
}

/** Explicit destination approval plus any configured offer-number requirement.
 * The caller determines EU membership. This is not a legal scope assessment. */
export function euSaleOpen(country: string, file: RegistrationsFile = REGISTRATIONS): boolean {
  const entry = entryOf(file, country);
  if (!entry || entry.saleApproved !== true) return false;
  if (!entry.offerNeedsNumber) return true;
  return Boolean(entry[requiredKind(country)]?.trim());
}

/** The numbers set for one country, in a fixed order. */
export function registrationNumbers(country: string | null, file: RegistrationsFile = REGISTRATIONS): RegistrationNumber[] {
  const entry = country ? entryOf(file, country) : null;
  if (!entry) return [];
  return KINDS.flatMap((kind) => {
    const value = entry[kind]?.trim();
    return value ? [{kind, value}] : [];
  });
}

/** The countries with at least one number, by country name in `locale`,
 *  each with its numbers in a fixed order. `$`-prefixed keys are notes. */
export function registrationRows(file: RegistrationsFile, locale = 'en'): RegistrationRow[] {
  const names = new Intl.DisplayNames([locale], {type: 'region'});
  const rows: RegistrationRow[] = [];
  for (const country of Object.keys(file)) {
    if (country.startsWith('$')) continue;
    const numbers = registrationNumbers(country, file);
    if (numbers.length) rows.push({country, name: names.of(country) ?? country, numbers});
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, locale));
}
