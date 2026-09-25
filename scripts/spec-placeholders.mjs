#!/usr/bin/env node
// List every spec value marked as a placeholder, by product, column and key.
//
//   npm run specs:placeholders
//
// A placeholder is a spec key named in a `placeholders` array: at product
// level in content/products/<handle>.json (the value in `specs` or
// `specsExtra`), at tier level in `variants.<tier>.placeholders` (the tier's
// own `specs` or `specsExtra` value), or per accessory in
// content/accessories.json. The layer that supplies the shown value decides,
// the same way the PDP spec sheet merges them.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** mergeSpecs from app/lib/product-content.ts, for plain JSON. */
function merge(base, overrides = []) {
  const out = base.map(([k, v]) => [k, v]);
  for (const [k, v] of overrides) {
    const i = out.findIndex(([bk]) => bk === k);
    if (v === null) {
      if (i !== -1) out.splice(i, 1);
    } else if (i !== -1) out[i] = [k, v];
    else out.push([k, v]);
  }
  return out;
}

/** Placeholder rows of one product file: [{product, column, key, value}]. */
export function productPlaceholders(handle, content) {
  const columns = Object.keys(content.variants ?? {});
  const rows = [];
  for (const column of columns.length ? columns : ['']) {
    const variant = column ? content.variants[column] : undefined;
    const layers = [
      {rows: content.specs ?? [], own: false},
      {rows: variant?.specs, own: true},
      {rows: content.specsExtra, own: false},
      {rows: variant?.specsExtra, own: true},
    ];
    const table = layers.reduce((t, l) => merge(t, l.rows), []);
    for (const [key, value] of table) {
      const source = [...layers].reverse().find((l) => l.rows?.some(([k, v]) => k === key && v !== null));
      const marked = source?.own ? variant?.placeholders : content.placeholders;
      if (marked?.includes(key)) rows.push({product: handle, column, key, value});
    }
  }
  return rows;
}

/** Every placeholder in the storefront content, products then accessories. */
export function listPlaceholders(root = ROOT) {
  const dir = path.join(root, 'content', 'products');
  const rows = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    const content = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    rows.push(...productPlaceholders(name.slice(0, -5), content));
  }
  const accessoriesPath = path.join(root, 'content', 'accessories.json');
  if (fs.existsSync(accessoriesPath)) {
    const accessories = JSON.parse(fs.readFileSync(accessoriesPath, 'utf8'));
    for (const [handle, a] of Object.entries(accessories)) {
      rows.push(...productPlaceholders(handle, {specs: a.specs, placeholders: a.placeholders}));
    }
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const rows = listPlaceholders();
  for (const r of rows) {
    console.log(`${r.product}${r.column ? ` [${r.column}]` : ''}  ${r.key}: ${r.value}`);
  }
  console.log(`${rows.length} placeholder spec value(s)`);
}
