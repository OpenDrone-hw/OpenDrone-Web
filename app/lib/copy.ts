/**
 * The site's words, as data.
 *
 * Every editable string lives in `content/copy/<page>.json` and is loaded here
 * at build time by `import.meta.glob({eager: true})`. That matters for two
 * reasons: the Oxygen worker has no filesystem, so the files have to be bundled
 * rather than read; and Vite tracks the glob as a real dependency, so saving a
 * file in the studio invalidates the module and hot-reloads the page. Live
 * preview is a side effect of doing the boring thing correctly.
 *
 * This replaced a hand-synced markdown mirror in which a human edited a file
 * and an agent copied the change back into the source. Nothing read that
 * mirror, and it had drifted badly by the time it was deleted. Here the file
 * IS the source.
 */

/** One page's strings. Values are plain text, or an array of paragraphs. */
export type CopyValue = string | string[];
export type CopyFile = Record<string, CopyValue>;

// Absolute-from-repo-root glob. `content/` sits outside `app/`, so the `~`
// alias cannot reach it; Vite resolves a leading slash against the project root.
/**
 * Guarded so the module can also be imported by the node:test suites, which run
 * the TypeScript directly with no bundler and have no `import.meta.glob`. Vite
 * still rewrites the call itself, so the real build is unaffected.
 */
const FILES = import.meta.env
  ? import.meta.glob<{default: CopyFile}>('/content/copy/*.json', {eager: true})
  : {};

/** `/content/copy/home.json` -> `home` */
function pageOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1, -'.json'.length);
}

const PAGES: Record<string, CopyFile> = {};
for (const [filePath, mod] of Object.entries(FILES)) {
  PAGES[pageOf(filePath)] = mod.default ?? {};
}

/**
 * A copy id is `<page>.<key>`, e.g. `home.hero_line1`. Keys may contain dots
 * for grouping (`nav.cart.label`), so only the FIRST segment is the page.
 */
export function splitId(id: string): {page: string; key: string} {
  const i = id.indexOf('.');
  if (i < 0) return {page: id, key: ''};
  return {page: id.slice(0, i), key: id.slice(i + 1)};
}

/**
 * Look up a string. Returns `undefined` when missing rather than throwing or
 * substituting a placeholder: a missing key is a bug to see in the studio, but
 * it must never take down a product page in production. Callers render their
 * own fallback, and `<Txt>` renders nothing.
 */
export function copy(id: string): CopyValue | undefined {
  const {page, key} = splitId(id);
  return PAGES[page]?.[key];
}

/** Same, narrowed to a single string. Arrays collapse to their first entry. */
export function copyText(id: string): string | undefined {
  const v = copy(id);
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** Every page name that has a copy file. Drives the studio's page tree. */
export function copyPages(): string[] {
  return Object.keys(PAGES).sort();
}

/** One page's whole record, for the studio inspector. */
export function copyPage(page: string): CopyFile | undefined {
  return PAGES[page];
}

/** Every id on a page, sorted. */
export function copyKeys(page: string): string[] {
  return Object.keys(PAGES[page] ?? {}).sort();
}

/**
 * The annotation the studio clicks on.
 *
 * Borrowed from Netlify Visual Editor's `data-sb-field-path`: tag the rendered
 * element with the id it came from, and a click in the preview can be mapped
 * back to the exact file and key. Explicit beats Sanity's approach of hiding the
 * id inside the string with invisible characters, which corrupts the value and
 * needs a denylist of fields where it breaks.
 *
 * Emitted in dev only. In production these attributes are dead weight in the
 * HTML, and `import.meta.env.DEV` is statically false there, so the object
 * folds away at build time. Same trick `app/lib/builder/registry.ts` uses.
 */
export function editAttrs(id: string): Record<string, string> {
  return import.meta.env.DEV ? {'data-edit': id} : {};
}

/**
 * A copy string with `{name}` placeholders filled from `vars`, or the
 * fallback with the same placeholders filled. Unknown placeholders stay as
 * written, so a typo in the studio is visible rather than silently blank.
 */
export function copyFill(
  id: string,
  fallback: string,
  vars: Record<string, string | number> = {},
): string {
  return (copyText(id) ?? fallback).replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
