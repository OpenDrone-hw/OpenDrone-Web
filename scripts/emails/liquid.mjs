// Shopify notification Liquid for the email preview and its test.
//
// liquidjs with the Shopify filters the bodies use shimmed on top, rendered
// against the fixtures in scripts/emails/fixtures/. Every render is checked
// three ways so a broken template is visible before it is pasted into
// Shopify admin: the global variable paths it reads must exist in the
// fixture, every filter must be known, and a strict render must pass (which
// also catches loop variables such as `line.titel`).

import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Liquid} from 'liquidjs';

import {BODIES_DIR, MAPPINGS_PATH, OUT_DIR, composeTemplate} from '../shopify-templates/gen.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(HERE, 'fixtures');
export const ADMIN_URL = 'https://admin.shopify.com/store/ktjqug-jw/email_templates';

// Shopify filters the preview implements. A filter outside this list and
// outside liquidjs's own standard set is reported as unknown.
const SHOPIFY_FILTERS = [
  'money',
  'money_with_currency',
  'money_without_currency',
  'money_without_trailing_zeros',
  'img_url',
  'image_url',
  'format_address',
];

// Array and string members Liquid resolves without a real property.
const BUILTIN_MEMBERS = new Set(['size', 'first', 'last']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge for fixtures: objects merge, arrays and scalars replace. */
export function merge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = {...base};
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

/** Fixtures as {id, file, meta, context}: each scenario merged over _base.json. */
export async function loadFixtures() {
  const files = (await fs.readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
  const base = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, '_base.json'), 'utf8'));
  delete base._note;
  const out = [];
  for (const file of files) {
    if (file.startsWith('_')) continue;
    const raw = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, file), 'utf8'));
    const {_scenario: meta, ...context} = raw;
    if (!meta?.title || !Array.isArray(meta.templates)) {
      throw new Error(`fixtures/${file}: needs "_scenario": {"title", "templates": [...]}`);
    }
    out.push({id: file.replace(/\.json$/, ''), file: `scripts/emails/fixtures/${file}`, meta, context: merge(base, context)});
  }
  return out;
}

/** Phase 1 templates (those with a body) with their sources and paste targets. */
export async function loadTemplates() {
  const mappingsRaw = await fs.readFile(MAPPINGS_PATH, 'utf8');
  const out = [];
  for (const tpl of JSON.parse(mappingsRaw).templates) {
    let body;
    try {
      body = await fs.readFile(path.join(BODIES_DIR, `${tpl.key}.html`), 'utf8');
    } catch {
      continue;
    }
    const html = composeTemplate(body, tpl);
    let generated = null;
    try {
      generated = await fs.readFile(path.join(OUT_DIR, `${tpl.key}.html`), 'utf8');
    } catch {
      // no out/ file yet: reported as stale
    }
    out.push({
      ...tpl,
      html,
      bodyFile: `scripts/shopify-templates/bodies/${tpl.key}.html`,
      outStale: generated !== html,
      adminUrl: `${ADMIN_URL}/${tpl.adminPath}/edit`,
    });
  }
  return out;
}

// A fixture image written as "placeholder:<label>" becomes an inline SVG, so
// the preview and the static gallery make no image requests of their own.
function imageSrc(value) {
  const src = typeof value === 'string' ? value : value?.src ?? value?.url ?? value?.image;
  if (typeof src === 'object' && src !== null) return imageSrc(src);
  if (typeof src !== 'string' || !src) throw new Error(`image filter: no image on ${JSON.stringify(value)?.slice(0, 80)}`);
  if (!src.startsWith('placeholder:')) return src;
  const label = src.slice('placeholder:'.length).replace(/[<&"]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#1a241a"/><text x="60" y="66" font-family="monospace" font-size="13" fill="#ffb700" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function cents(value, filter) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new Error(`${filter}: expected an amount in cents, got ${JSON.stringify(value)}`);
  }
  return n;
}

// Shopify money format placeholders ({{amount}}, {{amount_with_comma_separator}}, ...).
function formatMoney(amountCents, format) {
  const group = (s, sep) => s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  const fixed = (Math.abs(amountCents) / 100).toFixed(2);
  const [whole, dec] = fixed.split('.');
  const noDec = String(Math.round(Math.abs(amountCents) / 100));
  const values = {
    amount: `${group(whole, ',')}.${dec}`,
    amount_no_decimals: group(noDec, ','),
    amount_with_comma_separator: `${group(whole, '.')},${dec}`,
    amount_no_decimals_with_comma_separator: group(noDec, '.'),
    amount_with_apostrophe_separator: `${group(whole, "'")}.${dec}`,
  };
  const out = format.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`money format: unknown placeholder ${m}`);
    return values[key];
  });
  return amountCents < 0 ? `-${out}` : out;
}

/** A liquidjs engine with the Shopify shims bound to one fixture's shop. */
export function createEngine(context, {strict = true, strictFilters = strict} = {}) {
  const engine = new Liquid({strictVariables: strict, strictFilters, ownPropertyOnly: true});
  const shop = context.shop ?? {};
  const fmt = (key) => {
    if (typeof shop[key] !== 'string') throw new Error(`fixture: shop.${key} is required for money filters`);
    return shop[key];
  };
  engine.registerFilter('money', (v) => formatMoney(cents(v, 'money'), fmt('money_format')));
  engine.registerFilter('money_with_currency', (v) => formatMoney(cents(v, 'money_with_currency'), fmt('money_with_currency_format')));
  engine.registerFilter('money_without_currency', (v) => formatMoney(cents(v, 'money_without_currency'), '{{amount}}'));
  engine.registerFilter('money_without_trailing_zeros', (v) =>
    formatMoney(cents(v, 'money_without_trailing_zeros'), fmt('money_format')).replace(/[.,]00(?!\d)/, ''),
  );
  engine.registerFilter('img_url', (v) => imageSrc(isPlainObject(v) && 'image' in v ? v.image : v));
  engine.registerFilter('image_url', (v) => imageSrc(isPlainObject(v) && 'image' in v ? v.image : v));
  engine.registerFilter('format_address', (a) =>
    isPlainObject(a)
      ? [a.name, a.company, a.address1, a.address2, [a.zip, a.city].filter(Boolean).join(' '), a.province, a.country]
          .filter(Boolean)
          .join('<br>')
      : '',
  );
  return engine;
}

const KNOWN_FILTERS = new Set([...Object.keys(new Liquid().filters), ...SHOPIFY_FILTERS]);

// Every `| filter` in the source, so all unknown filters are listed at once
// rather than only the first one the strict parser trips on.
function unknownFilters(source) {
  const found = new Map();
  const tags = source.match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) ?? [];
  for (const tag of tags) {
    const stripped = tag.replace(/'[^']*'|"[^"]*"/g, '""');
    for (const m of stripped.matchAll(/\|\s*([A-Za-z_][\w-]*)/g)) {
      if (!KNOWN_FILTERS.has(m[1])) found.set(m[1], true);
    }
  }
  return [...found.keys()];
}

// Global variable paths the template reads that the fixture does not have.
// A null along the path is Shopify's nil and fine; a missing key is not.
function missingPaths(engine, parsed, context) {
  const missing = new Set();
  for (const segments of engine.globalVariableSegmentsSync(parsed)) {
    let cur = context;
    const walked = [];
    for (const seg of segments) {
      if (Array.isArray(seg)) break; // dynamic index, checked at render time
      if (cur === null || cur === undefined) break;
      const has =
        (typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg)) ||
        ((Array.isArray(cur) || typeof cur === 'string') && BUILTIN_MEMBERS.has(seg));
      walked.push(seg);
      if (!has) {
        missing.add(walked.join('.'));
        break;
      }
      cur = typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined;
    }
  }
  return [...missing];
}

/**
 * Render Liquid against a fixture context. Returns the output and every
 * problem found; when the strict render fails, `output` is the lenient
 * render so the card still shows what Shopify would roughly produce.
 */
export function renderLiquid(source, context) {
  const errors = [];
  // Unknown filters are already listed above; a strict filter check here
  // would stop the render before it reaches the loop variables.
  const strict = createEngine(context, {strictFilters: false});
  const lenient = createEngine(context, {strict: false});
  for (const f of unknownFilters(source)) {
    errors.push(`unknown filter "${f}": not a liquidjs standard filter and not shimmed in scripts/emails/liquid.mjs`);
  }
  let parsed;
  let missing;
  try {
    parsed = lenient.parse(source);
    missing = missingPaths(lenient, parsed, context);
  } catch (err) {
    errors.push(`parse error: ${err.message}`);
    return {output: '', errors};
  }
  for (const p of missing) {
    errors.push(`unknown variable "${p}": not in the fixture (a typo, or a Shopify variable the fixture lacks)`);
  }
  // Blank the reported globals so the strict render goes on to the loop
  // variables instead of stopping at the first missing global.
  const patched = structuredClone(context);
  for (const p of missing) {
    const keys = p.split('.');
    let cur = patched;
    for (const k of keys.slice(0, -1)) cur = cur[k];
    cur[keys.at(-1)] = '';
  }
  let output;
  try {
    output = strict.renderSync(parsed, patched);
  } catch (err) {
    errors.push(`strict render: ${err.message}`);
    output = lenient.renderSync(parsed, context);
  }
  return {output, errors};
}
