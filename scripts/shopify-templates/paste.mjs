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
const SAVE_READBACK_DELAYS = [0, 1_000, 2_000, 3_000];

class LoginRequired extends Error {}

async function openEditor(page, tpl) {
  await page.goto(editUrl(HANDLE, tpl.adminPath), {waitUntil: 'domcontentloaded'});
  const url = () => page.url();
  // CodeMirror 6 normally; a few templates (abandoned checkout) get a plain textarea.
  const editor = page.waitForFunction(
    () => {
      if (document.querySelector('.cm-content')?.cmView?.view) return true;
      const walk = (root) =>
        [...root.querySelectorAll('*')].some(
          (el) => (el.tagName === 'TEXTAREA' && el.value.length > 200) || (el.shadowRoot && walk(el.shadowRoot)),
        );
      return walk(document);
    },
    null,
    {timeout: EDITOR_TIMEOUT, polling: 500},
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

// One in-page function for read and write. No eval (the admin CSP forbids it), so
// everything is inlined here. `text` null = read only.
function pageAccess([text, subject]) {
  const inputs = [];
  const areas = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'INPUT' && (el.type === 'text' || !el.type)) inputs.push(el);
      if (el.tagName === 'TEXTAREA') areas.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  // The subject is the first text input that is not the admin search or Sidekick box.
  const input = inputs.find(
    (el) => el.name !== 'sidekickMessage' && !/^(search|work with sidekick)/i.test(el.getAttribute('aria-label') || ''),
  );
  const view = document.querySelector('.cm-content')?.cmView?.view;
  const area = view ? null : areas.sort((x, y) => y.value.length - x.value.length)[0];
  const setNative = (el, proto, v) => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
    el.dispatchEvent(new Event('change', {bubbles: true, composed: true}));
  };
  if (text !== null) {
    if (!input) return {error: 'subject input not found'};
    if (view) view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}});
    else if (area) return {error: 'editor is a read-only textarea'};
    else return {error: 'no editor'};
    setNative(input, HTMLInputElement.prototype, subject);
  }
  return {
    body: view ? view.state.doc.toString() : area ? area.value : null,
    subject: input ? input.value : null,
  };
}

async function readLive(page) {
  const r = await page.evaluate(pageAccess, [null, null]);
  if (r.body == null) throw new Error('editor body not readable');
  return r;
}

async function write(page, tpl, html) {
  const r = await page.evaluate(pageAccess, [html, tpl.emailSubject]);
  if (r.error) throw new Error(r.error);
  const save = page.getByRole('button', {name: /^save$/i}).first();
  await save.waitFor({state: 'visible', timeout: 15_000});
  await save.click();
  await save.waitFor({state: 'hidden', timeout: 30_000});
}

async function processOne(page, tpl, html, apply) {
  await openEditor(page, tpl);
  let live = await readLive(page);
  let row = planRow(tpl, html, live);
  if (apply && row.action !== 'ok') {
    await write(page, tpl, html);
    // Save once; Shopify can return the previous template on the first reload.
    let after = row;
    for (const delay of SAVE_READBACK_DELAYS) {
      if (delay) await page.waitForTimeout(delay);
      await page.reload({waitUntil: 'domcontentloaded'});
      await openEditor(page, tpl);
      live = await readLive(page);
      after = planRow(tpl, html, live);
      if (after.action === 'ok') break;
    }
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
