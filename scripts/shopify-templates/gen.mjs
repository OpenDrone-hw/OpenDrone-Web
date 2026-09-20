#!/usr/bin/env node
// Shopify notification template generator.
//
// Reads scripts/shopify-templates/_base.html + bodies/<key>.html, replaces
// {{TITLE}}, {{BADGE}}, {{PREHEADER}} with per-template metadata from
// mappings.json, and writes ready-to-paste HTML to
// scripts/shopify-templates/out/<key>.html.
//
// Usage:  npm run gen:shopify-templates

import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_PATH = path.join(__dirname, '_base.html');
const BODIES_DIR = path.join(__dirname, 'bodies');
const OUT_DIR = path.join(__dirname, 'out');
const MAPPINGS_PATH = path.join(__dirname, 'mappings.json');

async function main() {
  const [baseRaw, mappingsRaw] = await Promise.all([
    fs.readFile(BASE_PATH, 'utf8'),
    fs.readFile(MAPPINGS_PATH, 'utf8'),
  ]);
  const mappings = JSON.parse(mappingsRaw);

  await fs.mkdir(OUT_DIR, {recursive: true});

  let count = 0;
  const missing = [];

  for (const tpl of mappings.templates) {
    const bodyPath = path.join(BODIES_DIR, `${tpl.key}.html`);
    let body;
    try {
      body = await fs.readFile(bodyPath, 'utf8');
    } catch {
      missing.push(tpl.key);
      continue;
    }

    // Footer unsubscribe link for the marketing-flavored templates
    // (mappings.json `unsubscribeFooter: true`). Notification Liquid has
    // no unsubscribe variable, so the link goes to the site's manual
    // form with the address prefilled. Transactional templates get ''.
    const unsubscribe = tpl.unsubscribeFooter
      ? ' &middot;\n                  <a href="{{ shop.url }}/newsletter/unsubscribe?email={{ customer.email | url_encode }}" style="color: #a0a0a0; text-decoration: underline;">unsubscribe</a>'
      : '';

    let html = baseRaw.replaceAll('{{BODY_SLOT}}', body);
    html = html
      .replaceAll('{{TITLE}}', tpl.title)
      .replaceAll('{{BADGE}}', tpl.badge)
      .replaceAll('{{PREHEADER}}', tpl.preheader)
      .replaceAll('{{UNSUBSCRIBE}}', unsubscribe);

    const outPath = path.join(OUT_DIR, `${tpl.key}.html`);
    await fs.writeFile(outPath, html, 'utf8');
    count += 1;
  }

  console.log(`✓ Generated ${count} template(s) → scripts/shopify-templates/out/`);
  if (missing.length) {
    console.log(
      `\n⚠ Missing bodies (${missing.length}) — create:`,
    );
    for (const key of missing) {
      console.log(`  scripts/shopify-templates/bodies/${key}.html`);
    }
  }
}

main().catch((err) => {
  console.error('[gen.mjs] failed', err);
  process.exit(1);
});
