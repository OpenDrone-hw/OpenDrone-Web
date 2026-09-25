/**
 * Every copy id the code asks for must exist in `content/copy/`.
 *
 * The studio edits only keys that are present in a copy file. A key that the
 * code references with a fallback but that is missing from the JSON renders
 * fine and is silently uneditable. This check finds those.
 *
 *   node scripts/studio-keys.mjs
 *
 * Scanned forms, in `app/` (studio code excluded):
 *
 *   <Txt id="page.key" ...>        copyText('page.key')
 *   copy('page.key')               editAttrs('page.key')
 *   copyFill('page.key', ...)
 *   t('key', ...), say('key', ...) and any other file-local helper whose body
 *   reads `copyText(\`page.${key}\`)` or `copy(\`page.${key}\`)`
 *   any other quoted literal of the form 'page.key' whose page has a copy
 *   file (helper arguments, `copyId:` data, ternary branches)
 *
 * A template id with interpolation (`roadmap.status_${s}_label`) cannot be
 * resolved statically; it fails only when its pattern matches no key at all.
 *
 * Exit 0 when every id resolves, 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const COPY_DIR = path.join(root, 'content/copy');

/** page -> Set of keys */
const pages = new Map();
for (const f of fs.readdirSync(COPY_DIR)) {
  if (!f.endsWith('.json')) continue;
  const data = JSON.parse(fs.readFileSync(path.join(COPY_DIR, f), 'utf8'));
  pages.set(f.slice(0, -'.json'.length), new Set(Object.keys(data)));
}

function has(id) {
  const i = id.indexOf('.');
  if (i < 0) return false;
  return pages.get(id.slice(0, i))?.has(id.slice(i + 1)) ?? false;
}

/** Does any key match a template id with `${...}` holes? */
function patternHasMatch(tpl) {
  const parts = tpl.split(/\$\{[^}]*\}/);
  const re = new RegExp(
    '^' + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$',
  );
  for (const [page, keys] of pages) {
    for (const k of keys) if (re.test(`${page}.${k}`)) return true;
  }
  return false;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'studio' || e.name === 'node_modules') continue;
      walk(abs, out);
    } else if (/\.(tsx?|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      if (e.name === 'studio.tsx') continue;
      out.push(abs);
    }
  }
  return out;
}

/** Remove comments while keeping line numbers stable. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^(\s*)\/\/.*$/gm, '$1');
}

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

const STRING = String.raw`(?:'([^'\n]*)'|"([^"\n]*)"|\x60([^\x60]*)\x60)`;
const DIRECT = [
  new RegExp(String.raw`<Txt\b[^>]*?\bid=(?:\{\s*)?${STRING}`, 'g'),
  new RegExp(String.raw`\b(?:copyText|copyFill|copy|editAttrs)\(\s*${STRING}`, 'g'),
];
/** A quoted `page.key` literal anywhere; the page must exist to count. */
const BARE = /(['"])([a-z][a-z0-9-]*\.[A-Za-z0-9_][\w.-]*)\1/g;
/** A local helper: `function t(key` / `const t = (key` whose body reads `page.${key}`. */
const HELPER_DEF =
  /(?:function\s+(\w+)\s*\(\s*(\w+)|const\s+(\w+)\s*=\s*\(\s*(\w+))[\s\S]{0,400}?\b(?:copyText|copy)\(\s*`([\w-]+)\.\$\{(\w+)\}`\s*\)/g;

const missing = [];
const unresolved = [];
let checked = 0;

for (const file of walk(path.join(root, 'app'))) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const rel = path.relative(root, file);

  const report = (id, index, dynamic) => {
    checked++;
    if (dynamic) {
      if (!patternHasMatch(id)) unresolved.push(`${rel}:${lineOf(src, index)}  ${id}`);
    } else if (!has(id)) {
      missing.push(`${rel}:${lineOf(src, index)}  ${id}`);
    }
  };

  for (const re of DIRECT) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const id = m[1] ?? m[2] ?? m[3];
      if (!id.includes('.')) continue; // not a copy id (e.g. an HTML id)
      const dynamic = m[3] !== undefined && id.includes('${');
      // Template ids built from a local variable prefix only (`${id}-label`)
      // are HTML ids, not copy ids.
      if (dynamic && id.startsWith('${')) continue;
      // The helper bodies themselves (`cart.${key}`) are covered per call.
      if (dynamic && /^[\w-]+\.\$\{\w+\}$/.test(id)) continue;
      report(id, m.index, dynamic);
    }
  }

  // Any other string literal shaped like `<existing page>.<key>`: ids passed
  // through a local helper (`say('product-chrome.x', ...)`), held in data
  // (`copyId: 'collections-all.category_esc'`) or picked by a ternary.
  // Positions already reported above are skipped.
  const seen = new Set();
  for (const re of DIRECT) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) seen.add(m.index + m[0].length - (m[1] ?? m[2] ?? m[3]).length - 1);
  }
  BARE.lastIndex = 0;
  let b;
  while ((b = BARE.exec(src))) {
    const id = b[2];
    const start = b.index + 1;
    if (seen.has(start)) continue;
    if (!pages.has(id.slice(0, id.indexOf('.')))) continue;
    report(id, b.index, false);
  }

  HELPER_DEF.lastIndex = 0;
  let d;
  while ((d = HELPER_DEF.exec(src))) {
    const name = d[1] ?? d[3];
    const param = d[2] ?? d[4];
    const page = d[5];
    if (d[6] !== param) continue;
    const call = new RegExp(String.raw`(?<![\w.])${name}\(\s*${STRING}`, 'g');
    let c;
    while ((c = call.exec(src))) {
      const key = c[1] ?? c[2] ?? c[3];
      const dynamic = c[3] !== undefined && key.includes('${');
      report(`${page}.${key}`, c.index, dynamic);
    }
  }
}

if (missing.length || unresolved.length) {
  if (missing.length) {
    console.error(`Copy ids referenced in app/ but missing from content/copy (${missing.length}):`);
    for (const m of missing) console.error(`  ${m}`);
  }
  if (unresolved.length) {
    console.error(`Template copy ids that match no key (${unresolved.length}):`);
    for (const m of unresolved) console.error(`  ${m}`);
  }
  process.exit(1);
}
console.warn(`studio-keys: ${checked} copy references, all present in content/copy.`);
