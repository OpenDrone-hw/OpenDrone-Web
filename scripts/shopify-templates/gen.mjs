#!/usr/bin/env node
// Shopify notification template generator.
//
// Reads bodies/<key>.html, expands its <od-*> macros and wraps it in the shared
// shell (app/lib/email-shell.ts) with the per-template title, badge and
// preheader from mappings.json. Writes ready-to-paste HTML to
// scripts/shopify-templates/out/<key>.html.
//
// Usage:  npm run gen:shopify-templates

import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {applyFacts, expandMacros, shell} from '../../app/lib/email-shell.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BODIES_DIR = path.join(__dirname, 'bodies');
export const OUT_DIR = path.join(__dirname, 'out');
export const MAPPINGS_PATH = path.join(__dirname, 'mappings.json');

/** The pasteable template: shell + body with the mappings.json metadata.
 * Shared with the email preview (scripts/emails/). */
export function composeTemplate(body, tpl) {
  // Footer unsubscribe link for the marketing-flavored templates
  // (mappings.json `unsubscribeFooter: true`). Notification Liquid has
  // no unsubscribe variable, so the link goes to the site's manual
  // form with the address prefilled. Transactional templates get none.
  // The storefront is opendrone.be, not Shopify's shop.url, which the
  // headless redirect theme sends to the home page.
  const footerLinks = tpl.unsubscribeFooter
    ? ' &middot;\n                  <a href="https://opendrone.be/newsletter/unsubscribe?email={{ customer.email | url_encode }}" style="color: #a0a0a0; text-decoration: underline;">unsubscribe</a>'
    : '';
  return applyFacts(shell({
    title: tpl.title,
    badge: tpl.badge,
    preheader: tpl.preheader,
    body: expandMacros(body),
    footerLinks,
  }));
}

async function main() {
  const mappings = JSON.parse(await fs.readFile(MAPPINGS_PATH, 'utf8'));

  await fs.mkdir(OUT_DIR, {recursive: true});

  let count = 0;
  const missing = [];
  let deferred = 0;

  for (const tpl of mappings.templates) {
    const bodyPath = path.join(BODIES_DIR, `${tpl.key}.html`);
    let body;
    try {
      body = await fs.readFile(bodyPath, 'utf8');
    } catch {
      // Phase 2 templates have no body yet: Shopify's default stays live.
      if (tpl.phase === 1) missing.push(tpl.key);
      else deferred += 1;
      continue;
    }

    const html = composeTemplate(body, tpl);

    const outPath = path.join(OUT_DIR, `${tpl.key}.html`);
    await fs.writeFile(outPath, html, 'utf8');
    count += 1;
  }

  console.log(`Generated ${count} template(s) in scripts/shopify-templates/out/`);
  if (deferred) {
    console.log(`${deferred} phase 2 template(s) have no body; Shopify's default stays in use.`);
  }
  if (missing.length) {
    console.error(`Missing phase 1 bodies (${missing.length}), create:`);
    for (const key of missing) {
      console.error(`  scripts/shopify-templates/bodies/${key}.html`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('[gen.mjs] failed', err);
    process.exit(1);
  });
}
