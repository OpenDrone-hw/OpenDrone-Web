#!/usr/bin/env node
// End-to-end check of the header region control against a running site.
//
//   BASE=http://localhost:3000 npm run e2e:region      (dev server, any gates)
//   BASE=https://opendrone.be npm run e2e:region       (read-only: no cart is created)
//
// For each case it opens a product page in a fresh browser, as a visitor
// from `ip` (the CF-IPCountry header; only a local server honours it) or
// through a `?country` link, picks a country in the header picker and asserts
// that the control, the currency on the page and the choice cookie all moved,
// that the choice survives the next page, and that a ?country link never
// outranks a later pick (the "cannot choose US / USD" fault of 2026-11-11).
// Exits 1 on the first failure. Needs Chrome (playwright channel "chrome").

import {chromium} from 'playwright';

const BASE = (process.env.BASE ?? 'http://localhost:3000').replace(/\/+$/, '');
const LOCAL = /localhost|127\.0\.0\.1/.test(BASE);

const CASES = [
  {name: 'BE visitor picks US', ip: 'BE', pick: 'US', label: 'US · USD', currency: 'US$', cookie: 'US'},
  {name: 'US visitor picks Belgium', ip: 'US', pick: 'BE', label: 'BE · EUR', currency: '€', cookie: 'BE'},
  {name: 'JP visitor picks US then Japan again', ip: 'JP', pick: 'US', label: 'US · USD', currency: 'US$', cookie: 'US', back: {pick: 'JP', label: 'JP · EUR', cookie: 'JP'}},
  {name: '?country=BE link, then picks US (the reported fault)', link: 'BE', pick: 'US', label: 'US · USD', currency: 'US$', cookie: 'US'},
  {name: '?country=US link, then picks Belgium', link: 'US', pick: 'BE', label: 'BE · EUR', currency: '€', cookie: 'BE'},
  {name: '?country=JP link, picks US then Japan again', link: 'JP', pick: 'US', label: 'US · USD', currency: 'US$', cookie: 'US', back: {pick: 'JP', label: 'JP · EUR', cookie: 'JP'}},
];

const trigger = (page) => page.locator('.header-region-switch .header-popover-trigger');

/** Opens the header country picker and chooses the country with this ISO code. */
async function pick(page, code) {
  await trigger(page).click();
  const item = page.locator(`.header-region-switch [role=option][id$="-o-${code}"]`).first();
  await item.waitFor();
  // The switch posts the country, then React Router reads the loaders again.
  const posted = page.waitForResponse((r) => r.url().includes('/api/shopify/cart-country'), {timeout: 60000});
  const reread = posted.then(() =>
    page.waitForResponse((r) => r.url().includes('.data') && r.request().method() === 'GET', {timeout: 60000}),
  );
  await item.click();
  await reread;
  await page.waitForFunction(
    () => !document.querySelector('.header-region-switch[aria-busy="true"]'),
    null,
    {timeout: 30000},
  );
}

async function cookie(context) {
  return (await context.cookies(BASE)).find((c) => c.name === 'od_ship_country')?.value ?? null;
}

function check(failures, name, what, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${what} = ${JSON.stringify(got)}`);
  if (!ok) failures.push(`${name}: ${what}`);
}

async function main() {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const failures = [];
  for (const c of CASES) {
    if (c.ip && !LOCAL) {
      console.log(`skip ${c.name}: CF-IPCountry can only be set against a local server`);
      continue;
    }
    const context = await browser.newContext(c.ip ? {extraHTTPHeaders: {'CF-IPCountry': c.ip}} : {});
    const page = await context.newPage();
    await page.goto(`${BASE}/products/openfc-lite${c.link ? `?country=${c.link}` : ''}`, {waitUntil: 'networkidle'});
    if (c.link) check(failures, c.name, 'link dropped from the URL', new URL(page.url()).searchParams.has('country'), false);
    await pick(page, c.pick);
    check(failures, c.name, 'control', (await trigger(page).textContent())?.trim(), c.label);
    check(failures, c.name, 'cookie', await cookie(context), c.cookie);
    const text = await page.locator('main').innerText();
    check(failures, c.name, 'currency on page', text.includes(c.currency), true);
    await page.goto(`${BASE}/products`, {waitUntil: 'networkidle'});
    check(failures, c.name, 'control on the next page', (await trigger(page).textContent())?.trim(), c.label);
    if (c.back) {
      await pick(page, c.back.pick);
      check(failures, c.name, 'control after second pick', (await trigger(page).textContent())?.trim(), c.back.label);
      check(failures, c.name, 'cookie after second pick', await cookie(context), c.back.cookie);
    }
    await context.close();
  }
  await browser.close();
  if (failures.length) {
    console.error(`${failures.length} failed`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
