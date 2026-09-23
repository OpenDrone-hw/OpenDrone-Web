/**
 * Incutec BV's producer (EPR) registration numbers per EU country, from
 * `content/registrations.json`, and the consumer sale gate they set: DE,
 * FR, ES and IE require a number on the offer itself (`offerNeedsNumber`),
 * so consumer sale there opens only once that number is set.
 *
 * The file is bundled by Vite (`import.meta.glob`, as `app/lib/copy.ts`
 * does) and read from disk under node:test, so the gate and its tests use
 * the same data. Relative imports only, no worker APIs.
 */

export type RegistrationKind = 'weee' | 'packaging' | 'idu';

/** One country's numbers: `weee` and `packaging` everywhere, `idu` in
 *  France, null until registered; `offerNeedsNumber` where the law wants
 *  a number on the offer before selling. */
export type CountryRegistrations = Partial<Record<RegistrationKind, string | null>> & {
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

/**
 * Whether an EU country is open for consumer sale: it does not require a
 * number on the offer, or the number it requires is set. A country missing
 * from the file is closed. The caller decides which countries are EU.
 */
export function euSaleOpen(country: string, file: RegistrationsFile = REGISTRATIONS): boolean {
  const entry = entryOf(file, country);
  if (!entry) return false;
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
