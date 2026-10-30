/**
 * Design-token overrides authored in the studio.
 *
 * `content/theme.json` is a flat map of custom property to value. It is emitted
 * as a `:root{}` block after the stylesheet, so it overrides the `@theme`
 * defaults without touching app.css. The stylesheet stays the designed baseline
 * and this file is the diff on top of it, which means `git diff content/` shows
 * exactly what was changed and deleting the file restores the original design.
 *
 * Loaded through a glob rather than a direct import so a missing or empty file
 * is simply "no overrides" instead of a build error.
 */
/**
 * Guarded so the module can also be imported by the node:test suites, which run
 * the TypeScript directly with no bundler and have no `import.meta.glob`. Vite
 * still rewrites the call itself, so the real build is unaffected.
 */
const FILES = import.meta.env
  ? import.meta.glob<{default: Record<string, string>}>('/content/theme.json', {
      eager: true,
    })
  : {};

const OVERRIDES: Record<string, string> =
  Object.values(FILES)[0]?.default ?? {};

/**
 * Only accept things that look like a custom property and a value with no way
 * out of the declaration. The file is committed to the repo and only written by
 * a localhost-only dev endpoint, so this is not defending against an attacker;
 * it is making sure a malformed value breaks one token instead of terminating
 * the block early and taking the rest of the page's theme with it.
 */
const NAME_OK = /^--[a-zA-Z0-9-]+$/;
const VALUE_BAD = /[;{}<]|\/\*|\*\//;

/**
 * Reject a value whose brackets or quotes do not close.
 *
 * The character filter above is not sufficient on its own, because the value
 * never has to contain `;` or `}` to break out: the GENERATOR supplies those,
 * and an unterminated `url(` or string swallows them. `--evil: url(` turned
 * `{--color-bg:#000;--evil:url(;--color-accent:gold}` into one unclosed
 * function running to end of file, and the browser dropped the entire rule.
 * One bad token took the whole theme with it, which is precisely what the
 * filter exists to prevent.
 */
function balanced(v: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (const ch of v) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return depth === 0 && quote === null;
}

/**
 * The pure half, so the filters above can be tested without a bundler. The
 * loaded overrides are module state; the rules that decide what is safe to emit
 * are not, and those are the part worth pinning.
 */
export function buildThemeCss(overrides: Record<string, unknown>): string {
  const decls = Object.entries(overrides)
    .filter(
      ([k, v]) =>
        NAME_OK.test(k) &&
        typeof v === 'string' &&
        !VALUE_BAD.test(v) &&
        balanced(v),
    )
    .map(([k, v]) => `${k}:${(v as string).trim()}`);
  if (!decls.length) return '';
  // One rule per declaration, not one rule with many declarations: if a value
  // still manages to derail its own rule despite the checks above, it takes
  // only itself down instead of every other token.
  return decls.map((d) => `:root{${d}}`).join('');
}

export function themeOverrideCss(): string {
  return buildThemeCss(OVERRIDES);
}
