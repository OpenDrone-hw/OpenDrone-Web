/**
 * Checkout phone field: a dial-code prefix tied to the delivery country, as-you-type grouping and a per-country
 * check, with E.164 going to the app. A small static table instead of libphonenumber-js/min (152 kB, 36 kB gzipped,
 * measured with esbuild): the countries the shop ships to need a dial code, a length range and a grouping, nothing more.
 * Pure, so the node tests cover it.
 */

type Rule = {
  dial: string;
  /** National significant number length, digits after the dial code and without the trunk 0. */
  len: [number, number];
  /** Group sizes for the national number; the last group takes the rest. */
  groups: number[];
  /** Example in international form, shown as the placeholder and in the message. */
  example: string;
  /** A leading 0 typed after the dial code is the trunk prefix and is dropped (not in Italy, where it is part of the number). */
  trunk?: boolean;
  /** Mobile numbers group differently from the rest (Belgium, Netherlands, United Kingdom). */
  mobile?: {prefix: string; groups: number[]};
  first?: RegExp;
};

const R = (dial: string, len: [number, number], groups: number[], example: string, extra: Partial<Rule> = {}): Rule => ({dial, len, groups, example, trunk: true, ...extra});

export const PHONE_RULES: Record<string, Rule> = {
  BE: R('32', [8, 9], [2, 3, 2, 2], '+32 470 12 34 56', {first: /^[1-9]/, mobile: {prefix: '4', groups: [3, 2, 2, 2]}}),
  NL: R('31', [9, 9], [2, 3, 4], '+31 6 12 34 56 78', {first: /^[1-9]/, mobile: {prefix: '6', groups: [1, 2, 2, 2, 2]}}),
  DE: R('49', [7, 12], [3, 4, 4], '+49 151 1234 5678', {first: /^[1-9]/}),
  FR: R('33', [9, 9], [1, 2, 2, 2, 2], '+33 6 12 34 56 78', {first: /^[1-9]/}),
  LU: R('352', [6, 9], [3, 3, 3], '+352 621 123 456', {first: /^[2-9]/}),
  GB: R('44', [9, 10], [4, 6], '+44 7400 123456', {first: /^[1-9]/}),
  IE: R('353', [7, 9], [2, 3, 4], '+353 85 123 4567', {first: /^[1-9]/}),
  ES: R('34', [9, 9], [3, 3, 3], '+34 612 345 678', {first: /^[5-9]/, trunk: false}),
  IT: R('39', [6, 11], [3, 3, 4], '+39 312 345 6789', {trunk: false}),
  PT: R('351', [9, 9], [3, 3, 3], '+351 912 345 678', {first: /^[2-9]/, trunk: false}),
  AT: R('43', [4, 13], [3, 3, 4], '+43 664 123 4567', {first: /^[1-9]/}),
  CH: R('41', [9, 9], [2, 3, 2, 2], '+41 78 123 45 67', {first: /^[1-9]/}),
  DK: R('45', [8, 8], [2, 2, 2, 2], '+45 12 34 56 78', {trunk: false}),
  SE: R('46', [7, 10], [2, 3, 2, 2], '+46 70 123 45 67', {first: /^[1-9]/}),
  NO: R('47', [8, 8], [3, 2, 3], '+47 412 34 567', {trunk: false}),
  FI: R('358', [5, 11], [2, 3, 4], '+358 41 234 5678', {first: /^[1-9]/}),
  PL: R('48', [9, 9], [3, 3, 3], '+48 512 345 678', {trunk: false}),
  CZ: R('420', [9, 9], [3, 3, 3], '+420 601 123 456', {trunk: false}),
  GR: R('30', [10, 10], [3, 3, 4], '+30 691 234 5678', {trunk: false}),
  RO: R('40', [9, 9], [3, 3, 3], '+40 712 345 678', {first: /^[1-9]/}),
  HU: R('36', [8, 9], [2, 3, 4], '+36 20 123 4567', {first: /^[1-9]/}),
  SK: R('421', [9, 9], [3, 3, 3], '+421 912 345 678', {first: /^[1-9]/}),
  SI: R('386', [8, 8], [2, 3, 3], '+386 31 234 567', {first: /^[1-9]/}),
  HR: R('385', [8, 9], [2, 3, 4], '+385 91 234 5678', {first: /^[1-9]/}),
  BG: R('359', [8, 9], [3, 3, 3], '+359 88 123 4567', {first: /^[1-9]/}),
  LT: R('370', [8, 8], [3, 2, 3], '+370 612 34 567', {first: /^[1-9]/}),
  LV: R('371', [8, 8], [2, 3, 3], '+371 21 234 567', {trunk: false}),
  EE: R('372', [7, 8], [4, 4], '+372 5123 4567', {trunk: false}),
  US: R('1', [10, 10], [3, 3, 4], '+1 202 555 0123', {first: /^[2-9]/}),
  CA: R('1', [10, 10], [3, 3, 4], '+1 416 555 0123', {first: /^[2-9]/}),
  AU: R('61', [9, 9], [3, 3, 3], '+61 412 345 678', {first: /^[2-9]/}),
};

export const dialCode = (country: string): string => (PHONE_RULES[country.toUpperCase()]?.dial ?? '');
/** The prefix a country starts with: "+32 ", or an empty string for a country the table does not know. */
export const phonePrefix = (country: string): string => (dialCode(country) ? `+${dialCode(country)} ` : '');
export const phoneExample = (country: string): string => PHONE_RULES[country.toUpperCase()]?.example ?? '+32 470 12 34 56';

const BY_DIAL = [...new Set(Object.values(PHONE_RULES).map((r) => r.dial))].sort((a, b) => b.length - a.length);

/** Which dial code a run of digits starts with: the selected country's own first, else the longest one in the table. */
function splitDial(digits: string, country: string): {dial: string; national: string} {
  const own = dialCode(country);
  if (own && digits.startsWith(own)) return {dial: own, national: digits.slice(own.length)};
  const hit = BY_DIAL.find((d) => digits.startsWith(d));
  return hit ? {dial: hit, national: digits.slice(hit.length)} : {dial: digits.slice(0, 0), national: digits};
}

/** The rule of the country the typed dial code belongs to: the selected country when it shares the code (+1), else the first. */
function ruleFor(dial: string, country: string): Rule | null {
  const own = PHONE_RULES[country.toUpperCase()];
  if (own && own.dial === dial) return own;
  return Object.values(PHONE_RULES).find((r) => r.dial === dial) ?? null;
}

function group(national: string, sizes: number[]): string {
  const parts: string[] = [];
  let at = 0;
  for (let i = 0; i < sizes.length && at < national.length; i++) {
    const last = i === sizes.length - 1;
    parts.push(national.slice(at, last ? undefined : at + sizes[i]));
    at += sizes[i];
  }
  return parts.join(' ');
}

export type Phone = {display: string; e164: string; dial: string; national: string};

/** Format what was typed as you type: always international ("+32 470 12 34 56"), the delivery country's code assumed when none is typed. */
export function formatPhone(raw: string, country: string): Phone {
  const typed = raw.replace(/[^\d+]/g, '');
  const digits = typed.replace(/\D/g, '');
  if (!digits) return {display: '', e164: '', dial: '', national: ''};
  const hasPlus = typed.startsWith('+');
  const own = dialCode(country);
  // "0470..." with no code is a national number; "0032..." is the old international form.
  let all = digits;
  if (!hasPlus && all.startsWith('00')) all = all.slice(2);
  else if (!hasPlus && own) all = own + all;
  const {dial, national: n0} = splitDial(all, country);
  if (!dial) return {display: `+${all}`, e164: `+${all}`, dial: '', national: all};
  const rule = ruleFor(dial, country);
  const national = rule?.trunk ? n0.replace(/^0+/, '') : n0;
  const sizes = rule?.mobile && national.startsWith(rule.mobile.prefix) ? rule.mobile.groups : rule?.groups ?? [3, 3, 3, 3];
  return {display: `+${dial}${national ? ' ' + group(national, sizes) : ' '}`, e164: national ? `+${dial}${national}` : '', dial, national};
}

/** A plain message for a number that cannot be right, or null (an empty field or just the prefix is fine: the phone is optional). */
export function phoneProblem(raw: string, country: string, countryName = country): string | null {
  const p = formatPhone(raw, country);
  if (!p.national) return null;
  const rule = ruleFor(p.dial, country);
  const ex = rule ? rule.example : phoneExample(country);
  const fail = `Enter a valid phone number${p.dial === dialCode(country) ? ` for ${countryName}` : ''}, for example ${ex}.`;
  if (!rule) return p.national.length >= 6 && p.national.length <= 14 ? null : fail;
  const [min, max] = rule.len;
  if (p.national.length < min) return `That number is too short. ${fail}`;
  if (p.national.length > max) return `That number is too long. ${fail}`;
  if (rule.first && !rule.first.test(p.national)) return fail;
  if (p.dial === '32' && p.national.startsWith('4') && p.national.length !== 9) return `A Belgian mobile number has 9 digits after +32. ${fail}`;
  return null;
}

/** The field's value after the delivery country changed: the prefix follows unless the visitor typed another +code. */
export function phoneForCountry(current: string, from: string, to: string): string {
  const toP = phonePrefix(to);
  const typed = current.replace(/\s+/g, '');
  const own = dialCode(from);
  if (!typed || typed === `+${own}`) return toP;
  if (!typed.startsWith('+') || (own && typed.startsWith(`+${own}`))) {
    // The old country's own code (or a national number): re-prefix with the new one.
    const national = formatPhone(current, from).national;
    return national ? formatPhone(national, to).display : toP;
  }
  return current; // the visitor's own +code stays
}
