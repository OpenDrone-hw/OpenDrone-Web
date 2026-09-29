#!/usr/bin/env node
// sha256 of every pasteable Shopify notification (scripts/shopify-templates/out/*.html),
// so a live paste can be checked against the repo: paste, then compare the hash of
// what Shopify admin holds (copy the "Email body (HTML)" field into a file and run
// `shasum -a 256 file`) with the line printed here.
//
//   npm run emails:hash                 table: notification, out file, subject, sha256
//   npm run emails:hash -- --json       the same as JSON
//
// Only templates with a body (phase 1) are listed; the phase 2 notifications keep
// Shopify's default and have nothing to paste.

import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';

import {MAPPINGS_PATH, OUT_DIR} from '../shopify-templates/gen.mjs';

export async function pasteList() {
  const {templates} = JSON.parse(await fs.readFile(MAPPINGS_PATH, 'utf8'));
  const rows = [];
  for (const tpl of templates) {
    let html;
    try {
      html = await fs.readFile(path.join(OUT_DIR, `${tpl.key}.html`));
    } catch {
      continue;
    }
    rows.push({
      shopify_notification_name: tpl.shopifyName,
      out_file: `scripts/shopify-templates/out/${tpl.key}.html`,
      subject: tpl.emailSubject,
      sha256: createHash('sha256').update(html).digest('hex'),
    });
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = await pasteList();
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(`${r.sha256}  ${r.out_file}  (${r.shopify_notification_name}; subject: ${r.subject})`);
}
