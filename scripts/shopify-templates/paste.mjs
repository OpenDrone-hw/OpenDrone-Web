#!/usr/bin/env node
// Paste the generated Shopify notification templates into Shopify admin.
// Shopify has no API for notification templates, so this drives the admin in
// a Chrome started with `npm run emails:chrome` (remote debugging on 9222,
// dedicated profile). It never logs in and never types credentials: log into
// Shopify once in that Chrome window. It never toggles a notification and
// never sends mail.
//
//   npm run emails:paste                     dry run: table of live vs repo
//   npm run emails:paste -- --apply          write body and subject, save, verify
//   npm run emails:paste -- --only order-confirmation,shipping-confirmation
//   npm run emails:paste -- --apply --continue   keep going after a failure
//
// Env: SHOPIFY_ADMIN_STORE_HANDLE (default ktjqug-jw), CDP_URL (default
// http://127.0.0.1:9222).

import {promises as fs} from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright-core';

import {MAPPINGS_PATH, OUT_DIR} from './gen.mjs';
import {
  DEFAULT_STORE_HANDLE,
  editUrl,
  formatTable,
  parseArgs,
  planRow,
  selectTemplates,
  sha256,
} from './paste-lib.mjs';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const HANDLE = process.env.SHOPIFY_ADMIN_STORE_HANDLE || DEFAULT_STORE_HANDLE;
const EDITOR_TIMEOUT = 45_000;

class LoginRequired extends Error {}

async function openEditor(page, tpl) {
  await page.goto(editUrl(HANDLE, tpl.adminPath), {waitUntil: 'domcontentloaded'});
  const url = () => page.url();
  const editor = page.waitForFunction(
    () => document.querySelector('.cm-content')?.cmView?.view,
    null,
    {timeout: EDITOR_TIMEOUT},
  );
  const login = page
    .waitForURL(/accounts\.shopify\.com|\/login/, {timeout: EDITOR_TIMEOUT})
    .then(() => {
      throw new LoginRequired();
    });
  try {
    await Promise.race([editor, login]);
  } catch (e) {
    if (e instanceof LoginRequired || /accounts\.shopify\.com|\/login/.test(url())) {
      throw new LoginRequired();
    }
    throw new Error(`editor did not load at ${url()}`);
  }
}

async function readLive(page, tpl) {
  return page.evaluate(
    (expected) => {
      // No eval: the admin page CSP forbids it, so the finder is inlined per call.
      const findSubject = (expected) => {
        const inputs = [];
        const walk = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'INPUT' && (el.type === 'text' || !el.type)) inputs.push(el);
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(document);
        const label = (el) =>
          [el.getAttribute('aria-label'), el.name, el.id, el.closest('label')?.textContent]
            .filter(Boolean).join(' ');
        return inputs.find((el) => /subject/i.test(label(el))) ||
          inputs.find((el) => el.value === expected) || null;
      };
      const body = document.querySelector('.cm-content').cmView.view.state.doc.toString();
      const input = findSubject(expected);
      return {body, subject: input ? input.value : null};
    },
    tpl.emailSubject,
  );
}

async function write(page, tpl, html) {
  const ok = await page.evaluate(
    ([expected, text, subject]) => {
      const findSubject = (expected) => {
        const inputs = [];
        const walk = (root) => {
          for (const el of root.querySelectorAll('*')) {
            if (el.tagName === 'INPUT' && (el.type === 'text' || !el.type)) inputs.push(el);
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        };
        walk(document);
        const label = (el) =>
          [el.getAttribute('aria-label'), el.name, el.id, el.closest('label')?.textContent]
            .filter(Boolean).join(' ');
        return inputs.find((el) => /subject/i.test(label(el))) ||
          inputs.find((el) => el.value === expected) || null;
      };
      const view = document.querySelector('.cm-content').cmView.view;
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}});
      const input = findSubject(expected);
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, subject);
      input.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
      input.dispatchEvent(new Event('change', {bubbles: true, composed: true}));
      return true;
    },
    [tpl.emailSubject, html, tpl.emailSubject],
  );
  if (!ok) throw new Error('subject input not found');
  const save = page.getByRole('button', {name: /^save$/i}).first();
  await save.waitFor({state: 'visible', timeout: 15_000});
  await save.click();
  await save.waitFor({state: 'hidden', timeout: 30_000});
}

async function processOne(page, tpl, html, apply) {
  await openEditor(page, tpl);
  let live = await readLive(page, tpl);
  let row = planRow(tpl, html, live);
  if (apply && row.action !== 'ok') {
    await write(page, tpl, html);
    await page.reload({waitUntil: 'domcontentloaded'});
    await openEditor(page, tpl);
    live = await readLive(page, tpl);
    const after = planRow(tpl, html, live);
    if (after.action !== 'ok') {
      throw new Error(`verify failed after save: live ${after.liveHash?.slice(0, 12)} vs repo ${after.repoHash.slice(0, 12)}, subject ${after.subjectMatch ? 'match' : 'differs'}`);
    }
    row = {...after, action: 'applied'};
  }
  return row;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mappings = JSON.parse(await fs.readFile(MAPPINGS_PATH, 'utf8'));
  const templates = selectTemplates(mappings, opts.only);

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    console.error(`Cannot connect to Chrome at ${CDP_URL}. Run: npm run emails:chrome`);
    process.exit(2);
  }
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const rows = [];
  let failed = false;
  try {
    for (const tpl of templates) {
      const html = await fs.readFile(path.join(OUT_DIR, `${tpl.key}.html`), 'utf8');
      try {
        rows.push(await processOne(page, tpl, html, opts.apply));
      } catch (e) {
        if (e instanceof LoginRequired) {
          console.error('Shopify admin shows a login page: founder must log into Shopify in the opened Chrome window.');
          process.exit(3);
        }
        failed = true;
        rows.push({key: tpl.key, liveHash: null, repoHash: sha256(html), error: e.message});
        if (!opts.continueOnError) break;
      }
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {}); // disconnects; Chrome keeps running
  }
  console.log(`store ${HANDLE}  mode ${opts.apply ? 'APPLY' : 'dry run'}\n`);
  console.log(formatTable(rows));
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
