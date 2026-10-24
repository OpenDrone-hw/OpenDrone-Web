/**
 * Generate the studio's design-token catalogue by parsing the real stylesheet.
 *
 * The tokens are declared once, in the `@theme` block of app/styles/app.css.
 * Hand-copying them into the studio would guarantee drift the first time
 * someone adds a colour, so this reads them instead. Run it whenever `@theme`
 * changes:
 *
 *   npm run studio:tokens
 *
 * Output is committed so the studio has no build-order dependency on it.
 */
import fs from 'node:fs';
import path from 'node:path';

const CSS = path.resolve('app/styles/app.css');
const OUT = path.resolve('app/studio/token-catalogue.json');

// Strip comments BEFORE any brace counting. `blockBody` counts raw `{`/`}`,
// so a single `}` inside a comment truncates the block — and because it
// returns a short-but-non-null string, the `if (!theme) throw` guard never
// fires and the script silently writes zero tokens. Same class of bug as the
// opener that matched inside a comment.
const css = fs.readFileSync(CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Pull the body of a top-level block, brace-counting so nested rules survive.
 *
 * `opener` is a regex anchored to the start of a line, not a plain substring:
 * an indexOf could match inside a comment and brace-count from the wrong place.
 */
function blockBody(source, opener) {
  const m = opener.exec(source);
  if (!m) return null;
  const start = m.index;
  let i = source.indexOf('{', start);
  if (i < 0) return null;
  let depth = 0;
  const from = i + 1;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(from, i);
    }
  }
  return null;
}

const theme = blockBody(css, /^@theme\b/m);
if (!theme) throw new Error('No @theme block found in app/styles/app.css');
/** `--name: value;` at the top level of a block, ignoring comments. */
function parseDecls(body) {
  const out = [];
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(stripped))) {
    out.push({name: m[1], value: m[2].trim().replace(/\s+/g, ' ')});
  }
  return out;
}

const themeDecls = parseDecls(theme);

/**
 * Group by what the value IS, not by name prefix. A token called `--pod-bg`
 * holding an rgba() is a colour and should get a colour picker; one called
 * `--color-stock` holding `var(--color-green)` is an alias and must not, because
 * editing it through a picker would silently flatten the link to its source.
 */
function classify({name, value}) {
  if (/^var\(|^clamp\(|^min\(|^max\(|^calc\(/.test(value)) return 'derived';
  if (/^#|^rgb|^hsl|^oklch/.test(value)) return 'colour';
  if (name.startsWith('--font-')) return 'font';
  if (name.startsWith('--fs-')) return 'size';
  if (name.startsWith('--sp-')) return 'spacing';
  if (name.startsWith('--r-')) return 'radius';
  if (/shadow/.test(name)) return 'shadow';
  if (/^\d|px$|rem$|em$|%$/.test(value)) return 'layout';
  return 'other';
}

const tokens = themeDecls.map((d) => ({
  name: d.name,
  value: d.value,
  group: classify(d),
  // A derived token resolves through another one. The studio shows these as
  // read-only with their source, so nobody edits `--color-accent` wondering why
  // `--color-gold` did not move.
  derivedFrom: [...d.value.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]),
}));

if (tokens.length === 0) throw new Error('Parsed zero tokens from @theme — refusing to write an empty catalogue');

const catalogue = {
  $generated: 'npm run studio:tokens — do not hand-edit',
  $source: 'app/styles/app.css @theme',
  count: tokens.length,
  tokens,
};

fs.mkdirSync(path.dirname(OUT), {recursive: true});
fs.writeFileSync(OUT, `${JSON.stringify(catalogue, null, 2)}\n`);

const byGroup = tokens.reduce((a, t) => ({...a, [t.group]: (a[t.group] ?? 0) + 1}), {});
console.warn(`Wrote ${tokens.length} tokens to ${path.relative(process.cwd(), OUT)}`);
console.warn(
  Object.entries(byGroup)
    .sort()
    .map(([g, n]) => `  ${g}: ${n}`)
    .join('\n'),
);
