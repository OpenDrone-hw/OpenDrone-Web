/**
 * The words the catalog search matches on. Pure string helpers, shared by
 * the product listing (app/routes/products._index.tsx) and its tests.
 */

/** Case- and accent-insensitive form of a string, with mount patterns
 *  ("20×20", "20 x 20", "30.5 x 30.5") read as "20x20" / "30x30". */
export function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/(\d+)(?:\.5)?\s*[x×]\s*(\d+)(?:\.5)?/g, '$1x$2');
}

/** `5"`, `5 inch`, `5-inch` and `5in` all read as `5inch`. */
export function sizes(s: string): string {
  return s.replace(/(\d)\s*-?\s*(?:"|”|inch(?:es)?\b|in\b)/g, '$1inch');
}

/**
 * Dutch and French part words, as the English words the catalog uses. The
 * site greets Dutch and French browsers, so "motoren" or "ontvanger" must
 * find the motors and receivers. Applied to a normalised term, so accents
 * are already gone ("récepteur" is "recepteur" here). Phrases come first.
 */
const TRANSLATIONS: Array<[RegExp, string]> = [
  [/\bcontroleurs? de vol\b/g, 'flight controller'],
  [/\bvluchtcontrollers?\b/g, 'flight controller'],
  [/\bvluchtcomputers?\b/g, 'flight controller'],
  [/\bmotoren\b/g, 'motor'],
  [/\bmoteurs?\b/g, 'motor'],
  [/\bontvangers?\b/g, 'receiver'],
  [/\brecepteurs?\b/g, 'receiver'],
  [/\bchassis\b/g, 'frame'],
  [/\bregelaars?\b/g, 'esc'],
  [/\bvariateurs?\b/g, 'esc'],
];

/** A normalised term with its Dutch and French part words in English. */
export function translate(term: string): string {
  return TRANSLATIONS.reduce((t, [re, en]) => t.replace(re, en), term);
}

/**
 * A term as search words: normalised, translated, sizes joined, and the
 * radio bands buyers type ("868", "915 MHz", "900mhz") read as the spec
 * tables' own word for them, "sub-GHz".
 */
export function termWords(term: string): string[] {
  return sizes(translate(normalise(term)))
    .replace(/\b(?:868|915|900)\s*(?:mhz)?\b/g, 'sub-ghz')
    .split(/\s+/)
    .filter(Boolean);
}

/** The term as one string for the "no such thing here" help patterns. */
export function helpText(term: string): string {
  return sizes(translate(normalise(term)));
}
