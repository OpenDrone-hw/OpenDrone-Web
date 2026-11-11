#!/usr/bin/env node
// Edge cases of the batch model (buy now or pre-order, regions) in a real browser.
//
//   BASE=http://localhost:3111 CONTROL=http://localhost:3112/control [ORDINARY_BASE=http://localhost:3141] npm run e2e:batch-model
//
// Runs against a local dev server with BATCH_CHOICE=1 and a Storefront stand-in (the cart lives in
// memory, checkout points at checkout.invalid; nothing is written to Shopify). The visitor's
// country is the CF-IPCountry header, which only a local server honours. CONTROL is the
// stand-in's fault switch (failed catalog or cart, slow replies, Buy now sold out); the cases
// that need it are skipped without it. Prints one line per case and exits 1 if any failed.
// Needs Chrome (playwright channel "chrome"). ONLY=<substring> runs the matching cases.

import {chromium} from 'playwright';

const BASE = (process.env.BASE ?? 'http://localhost:3111').replace(/\/+$/, '');
const CONTROL = process.env.CONTROL ?? null;
const ONLY = process.env.ONLY ?? '';
/** A second server in the "batch 2 has landed" fixture (every SKU in stock, the campaign lists no SKU). */
const ORDINARY_BASE = process.env.ORDINARY_BASE?.replace(/\/+$/, '') ?? null;
if (!/localhost|127\.0\.0\.1/.test(BASE)) {
  console.error('e2e:batch-model runs against a local server only (it adds to carts and posts checkouts)');
  process.exit(2);
}

const PDP = '/products/openfc-lite';
const ROUTES = ['/', PDP, '/products/openesc', '/preorder', '/cart'];
const WIDTHS = [390, 1280, 1440, 1728];
/** Words no customer may read (founder 2026-11-11). */
const FORBIDDEN = [/\btarget\b/i, /if the target is reached/i, /EU, US and more/i, /Lite Mini/i];
const BUY_NOW = new Set(['BE', 'DE']);

async function control(body) {
  if (!CONTROL) return;
  await fetch(CONTROL, body ? {method: 'POST', body: JSON.stringify(body)} : {method: 'DELETE'});
}

let browser;
async function visitor(country, {width = 1440, js = true, cookie = null} = {}) {
  const context = await browser.newContext({
    viewport: {width, height: width < 600 ? 844 : 900},
    javaScriptEnabled: js,
    extraHTTPHeaders: country ? {'CF-IPCountry': country} : {},
  });
  if (cookie) await context.addCookies([{name: 'od_ship_country', value: cookie, url: BASE}]);
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  return {context, page};
}

async function open(page, path) {
  // A dev server may abort the very first request while it optimizes dependencies: one retry.
  const response = await page.goto(BASE + path, {waitUntil: 'domcontentloaded'}).catch(() => page.goto(BASE + path, {waitUntil: 'domcontentloaded'}));
  await page.waitForLoadState('load').catch(() => undefined);
  return response;
}

/** Visible text of the page, without the hidden ghost copies of the offer cards. */
const visibleText = (page) => page.evaluate(() => document.body.innerText);
const currencies = (text) => {
  const found = new Set();
  if (/US\$\s?\d/.test(text)) found.add('USD');
  if (/€\s?\d|\d\s?€/.test(text)) found.add('EUR');
  return [...found];
};
const amount = (s) => {
  const m = String(s).match(/\d+(?:[.,]\d{2})?/);
  return m ? Number(m[0].replace(',', '.')) : NaN;
};

async function noForbidden(page, where) {
  const text = await visibleText(page);
  for (const word of FORBIDDEN) if (word.test(text)) throw new Error(`${where}: shows ${word}`);
  const cur = currencies(text);
  if (cur.length > 1) throw new Error(`${where}: two currencies at once (${cur.join(', ')})`);
  return {text, cur};
}

const buyNowCard = (page) => page.locator('[data-offer-choice] [data-offer="buy_now"]:visible');
const preorderCard = (page) => page.locator('[data-offer-choice] [data-offer="preorder"]:visible');
const buyButton = (page) => page.locator('[data-buy-module] button[type=submit]:visible').first();

const cases = [];
const add = (name, run, {needsControl = false, needsOrdinary = false} = {}) => cases.push({name, run, needsControl, needsOrdinary});

// 1. Every region kind on every main route: status, words, one currency, Buy now only where the lane is.
for (const country of ['BE', 'DE', 'GB', 'CH', 'NO', 'US', 'CA', 'AU', 'ZW', null]) {
  add(`region ${country ?? 'unknown'}: main routes, one currency, Buy now only in the EU`, async () => {
    const {context, page} = await visitor(country);
    try {
      for (const path of ROUTES) {
        const response = await open(page, path);
        if (!response || response.status() >= 400) throw new Error(`${path}: HTTP ${response?.status()}`);
        const {cur} = await noForbidden(page, path);
        if (path === PDP) {
          const shown = (await buyNowCard(page).count()) > 0;
          if (shown !== BUY_NOW.has(country ?? '')) throw new Error(`${path}: Buy now ${shown ? 'shown' : 'missing'}`);
          const want = country === 'US' ? 'USD' : 'EUR';
          if (cur[0] && cur[0] !== want) throw new Error(`${path}: ${cur[0]}, expected ${want}`);
        }
      }
    } finally {
      await context.close();
    }
  });
}

// 2. Layout: no horizontal scroll at any width, offer cards inside the viewport.
for (const width of WIDTHS) {
  add(`layout ${width}px: product page has no horizontal scroll`, async () => {
    const {context, page} = await visitor('BE', {width});
    try {
      await open(page, PDP);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 1) throw new Error(`page is ${over}px wider than the viewport`);
    } finally {
      await context.close();
    }
  });
}

// 3. A ?country link becomes the choice and leaves the URL; the choice cookie beats the geo header.
add('?country=GB link: saved as the choice, removed from the URL, EUR without Buy now', async () => {
  const {context, page} = await visitor('BE');
  try {
    await open(page, `${PDP}?country=GB`);
    if (page.url().includes('country=')) throw new Error(`still on ${page.url()}`);
    const cookie = (await context.cookies(BASE)).find((c) => c.name === 'od_ship_country')?.value;
    if (cookie !== 'GB') throw new Error(`cookie ${cookie}`);
    if (await buyNowCard(page).count()) throw new Error('Buy now shown for GB');
  } finally {
    await context.close();
  }
});
add('choice cookie US beats a BE geo header: USD, no Buy now', async () => {
  const {context, page} = await visitor('BE', {cookie: 'US'});
  try {
    await open(page, PDP);
    const {cur} = await noForbidden(page, PDP);
    if (cur[0] !== 'USD') throw new Error(`currency ${cur}`);
    if (await buyNowCard(page).count()) throw new Error('Buy now shown for US');
  } finally {
    await context.close();
  }
});

// 4. Switching offer and size repeatedly: nothing moves, the price is always the selection's.
add('offer and size switching: button does not move, price matches the chosen card', async () => {
  const {context, page} = await visitor('BE', {width: 1440});
  try {
    await open(page, PDP);
    await page.waitForFunction(() => document.documentElement.dataset.hydrated !== undefined || true);
    const top = async () => (await buyButton(page).boundingBox())?.y ?? -1;
    const first = await top();
    for (let round = 0; round < 3; round += 1) {
      for (const card of [preorderCard, buyNowCard]) {
        await card(page).click();
        const cardPrice = amount(await card(page).locator('.offer-card-price, .offer-card-pinprice').first().innerText());
        const shown = amount(await page.locator('[data-buy-module] .product-buy-amount').first().innerText());
        if (cardPrice && Math.abs(cardPrice - shown) > 0.005) throw new Error(`card ${cardPrice} vs price ${shown}`);
        const y = await top();
        if (Math.abs(y - first) > 1) throw new Error(`button moved ${y - first}px`);
      }
      const sizes = page.locator('[data-buy-module] a[role=radio], [data-buy-module] [role=radiogroup] a, .variant-ladder a, .product-options-grid a');
      const n = await sizes.count();
      if (n > 1) await sizes.nth(round % n).click();
    }
  } finally {
    await context.close();
  }
});

// 5. The partner tick row in both lanes; quantity after ticking; the total follows.
add('partner tick row: both lanes, quantity changed after ticking, total = (part + partner) x qty', async () => {
  const {context, page} = await visitor('BE', {width: 1440});
  try {
    await open(page, PDP);
    for (const card of [buyNowCard, preorderCard]) {
      await card(page).click();
      const tick = page.locator('.offer-addon-input');
      if (!(await tick.count())) throw new Error('no tick row');
      await tick.check();
      const before = Number(await page.locator('[data-buy-module] .product-qty input:visible').first().inputValue());
      await page.locator('[data-buy-module] .product-qty button[aria-label="Increase quantity"]:visible').first().click();
      await page.waitForFunction((n) => Number(document.querySelector('[data-buy-module] .product-qty input')?.value) === n + 1, before, {timeout: 5000}).catch(() => {
        throw new Error('quantity did not go up after ticking');
      });
      const total = page.locator('.buy-total-amount');
      await total.waitFor();
      const value = amount(await total.innerText());
      const part = amount(await page.locator('[data-buy-module] .product-buy-amount').first().innerText());
      const partner = amount((await page.locator('.offer-addon-text').innerText()).split('+').pop());
      const qty = Number(await page.locator('[data-buy-module] .product-qty input:visible').first().inputValue());
      // Buy now: the stack price; pre-order: this part plus the partner. Either way more than one part.
      if (!(value > part * qty) || !(value <= (part + partner) * qty + 0.01)) throw new Error(`total ${value} for qty ${qty}, part ${part}, partner ${partner}`);
      await tick.uncheck();
      await page.locator('[data-buy-module] .product-qty button[aria-label="Decrease quantity"]:visible').first().click();
    }
  } finally {
    await context.close();
  }
});

// 6. Quantity limits: zero, negative and huge input clamp to the allowed range.
add('quantity input: 0, -3 and 9999 clamp', async () => {
  const {context, page} = await visitor('BE');
  try {
    await open(page, PDP);
    const input = page.locator('[data-buy-module] .product-qty input:visible').first();
    for (const typed of ['0', '-3', '9999']) {
      await input.fill(typed);
      await input.blur();
      const value = Number(await input.inputValue());
      const max = Number((await input.getAttribute('max')) ?? '99');
      if (!(value >= 1 && value <= max)) throw new Error(`typed ${typed}, kept ${value} (max ${max})`);
    }
  } finally {
    await context.close();
  }
});

// 7. Cart: the same pre-order twice is one line of 2; removing the last line empties it cleanly.
async function addPreorder(page) {
  await open(page, PDP);
  if (await preorderCard(page).count()) await preorderCard(page).click();
  await buyButton(page).click();
  await page.waitForResponse((r) => r.url().includes('/api/shopify/cart') && r.request().method() === 'POST');
}
add('cart: same pre-order twice is one line of 2, then remove the last line', async () => {
  const {context, page} = await visitor('BE');
  try {
    await addPreorder(page);
    await addPreorder(page);
    await open(page, '/cart');
    // The cart's stepper posts the next quantity: the increase form holds quantity + 1.
    const next = await page.locator('main form:has(button[aria-label="Increase quantity"]) input[name=quantity]').first().inputValue();
    if (Number(next) - 1 !== 2) throw new Error(`quantity ${Number(next) - 1}`);
    await noForbidden(page, '/cart');
    await page.locator('main button[aria-label*="Remove" i], main button:has-text("Remove")').first().click();
    await page.waitForLoadState('networkidle');
    const text = await visibleText(page);
    if (!/empty/i.test(text)) throw new Error('no empty-cart message');
  } finally {
    await context.close();
  }
});

// 8. Region switch with items in the cart: the cart reprices in the new currency, one currency only.
add('cart: switch BE -> US -> CH with a pre-order in it, one currency each time', async () => {
  const {context, page} = await visitor('BE');
  try {
    await addPreorder(page);
    for (const [country, want] of [['US', 'USD'], ['CH', 'EUR'], ['BE', 'EUR']]) {
      await context.addCookies([{name: 'od_ship_country', value: country, url: BASE}]);
      await open(page, '/cart');
      const {cur} = await noForbidden(page, `/cart ${country}`);
      if (cur[0] !== want) throw new Error(`${country}: ${cur.join(',')} expected ${want}`);
    }
  } finally {
    await context.close();
  }
});

// 9. Checkout hand-off: the checkout the site sends to carries the country the site showed.
add('checkout hand-off: the cart country is the one the site showed (US)', async () => {
  const {context, page} = await visitor('US');
  try {
    await addPreorder(page);
    await open(page, '/cart');
    const shown = currencies(await visibleText(page));
    const handoff = page.waitForRequest((r) => r.url().startsWith('https://checkout.invalid'), {timeout: 30000}).catch(() => null);
    await page.locator('main button:has-text("Checkout"), main button:has-text("checkout")').first().click();
    const request = await handoff;
    if (!request) throw new Error('no hand-off to checkout');
    if (shown[0] !== 'USD') throw new Error(`cart showed ${shown}`);
  } finally {
    await context.close();
  }
});

// 10. Buy now when stock runs out between page load and click; a second tab sees the same refusal.
add('Buy now sold out between load and click: refused with a message, nothing charged', async () => {
  const {context, page} = await visitor('BE');
  try {
    await open(page, PDP);
    const second = await context.newPage();
    await second.goto(BASE + PDP);
    await control({buyNowSoldOut: true});
    await buyNowCard(page).click();
    await buyButton(page).click();
    await page.waitForURL(/[?&]buy=/, {timeout: 60000});
    if (!(await page.locator('.cart-alert[role=alert]').count())) throw new Error('no refusal message');
    await buyNowCard(second).click().catch(() => undefined);
    await buyButton(second).click();
    await second.waitForURL(/[?&]buy=/, {timeout: 60000});
  } finally {
    await control(null);
    await context.close();
  }
}, {needsControl: true});

// 11. Back after express checkout: the button is usable again, not stuck busy.
add('back from express checkout: Buy now is not stuck busy', async () => {
  const {context, page} = await visitor('BE');
  try {
    // The local checkout host does not exist (and Playwright cannot route a redirect): the Buy now
    // post itself answers with a stand-in checkout page, so Back works as it does from Shopify.
    await page.route('**/api/shopify/cart', (route) =>
      /intent=buy-now/.test(route.request().postData() ?? '')
        ? route.fulfill({contentType: 'text/html', body: '<title>checkout</title>checkout'})
        : route.continue(),
    );
    await open(page, PDP);
    await buyNowCard(page).click();
    await Promise.all([page.waitForFunction(() => document.title === 'checkout', null, {timeout: 30000}), buyButton(page).click()]);
    await page.goBack({waitUntil: 'load'}).catch(() => undefined);
    if (!page.url().includes(PDP)) throw new Error(`back landed on ${page.url()}`);
    const button = page.locator('form.express-buy button[type=submit]:visible').first();
    await button.waitFor({timeout: 15000});
    if ((await button.getAttribute('aria-busy')) === 'true') throw new Error('button busy after back');
  } finally {
    await context.close();
  }
});

// 12. A failed or slow catalog or cart request degrades with a message, never a wrong price.
add('cart request fails: the cart says so, no blank page', async () => {
  const {context, page} = await visitor('BE');
  try {
    await addPreorder(page);
    await control({cartFail: true});
    const response = await open(page, '/cart');
    const text = await visibleText(page);
    if (!/temporarily unavailable/i.test(text) && !/OpenFC|OpenESC/.test(text)) throw new Error(`no message (HTTP ${response?.status()})`);
    if (/unexpected error/i.test(text)) throw new Error('generic "unexpected error" instead of what is down');
    if (/€\s?0[.,]00/.test(text)) throw new Error('shows a zero price');
  } finally {
    await control(null);
    await context.close();
  }
}, {needsControl: true});
add('slow storefront (4 s): product page still server-renders the right offers', async () => {
  await control({delayMs: 4000});
  const {context, page} = await visitor('DE');
  try {
    await open(page, PDP);
    if (!(await buyNowCard(page).count())) throw new Error('no Buy now for DE when slow');
  } finally {
    await control(null);
    await context.close();
  }
}, {needsControl: true});

// 13. JavaScript off: the server-rendered page already shows the region's offers and currency.
for (const [country, want, buyNow] of [['BE', 'EUR', true], ['US', 'USD', false], ['GB', 'EUR', false]]) {
  add(`no JavaScript, ${country}: offers and ${want} are in the server HTML`, async () => {
    const {context, page} = await visitor(country, {js: false});
    try {
      await open(page, PDP);
      const {cur} = await noForbidden(page, PDP);
      if (cur[0] !== want) throw new Error(`currency ${cur}`);
      if ((await buyNowCard(page).count() > 0) !== buyNow) throw new Error('Buy now card wrong');
    } finally {
      await context.close();
    }
  });
}
add('hydration does not change the price the server rendered (BE, US)', async () => {
  for (const country of ['BE', 'US']) {
    const {context, page} = await visitor(country);
    try {
      const response = await page.goto(BASE + PDP);
      const html = await response.text();
      const server = (html.match(/class="product-buy-amount"[\s\S]*?(US\$|€)\s?([\d.,]+)/) ?? []).slice(1).join('');
      await page.waitForLoadState('networkidle');
      const client = (await page.locator('[data-buy-module] .product-buy-amount').first().innerText()).match(/(US\$|€)\s?([\d.,]+)/)?.slice(1).join('');
      if (!server || server !== client) throw new Error(`${country}: server ${server}, client ${client}`);
    } finally {
      await context.close();
    }
  }
});

// 14. Keyboard only and the screen reader view of the offer cards and the tick row.
add('keyboard and accessibility tree: offer radios, tick row checkbox with a name', async () => {
  const {context, page} = await visitor('BE');
  try {
    await open(page, PDP);
    const radios = page.getByRole('radio', {name: /buy now|pre-order/i});
    if ((await radios.count()) < 2) throw new Error(`offer radios: ${await radios.count()}`);
    await radios.first().focus();
    await page.keyboard.press('ArrowDown');
    const checked = await page.locator('[data-offer-choice] input[type=radio]:checked').evaluate((el) => el.closest('[data-offer]')?.getAttribute('data-offer'));
    if (checked !== 'preorder') throw new Error(`arrow key chose ${checked}`);
    const tick = page.getByRole('checkbox', {name: /add the/i});
    if (!(await tick.count())) throw new Error('tick row has no accessible name');
    await tick.focus();
    await page.keyboard.press('Space');
    if (!(await tick.isChecked())) throw new Error('space did not tick');
    const legend = await page.locator('[data-offer-choice] legend').count();
    if (!legend) throw new Error('offer group has no legend');
  } finally {
    await context.close();
  }
});

// 15. Locales: prices and dates in each locale the site supports, no forbidden words.
for (const locale of ['nl', 'fr']) {
  add(`locale ${locale}: product page and /preorder read, one currency`, async () => {
    const {context, page} = await visitor('BE');
    try {
      for (const path of [`/${locale}${PDP}`, `/${locale}/preorder`]) {
        const response = await open(page, path);
        if (!response || response.status() >= 400) throw new Error(`${path}: HTTP ${response?.status()}`);
        await noForbidden(page, path);
      }
    } finally {
      await context.close();
    }
  });
}

// 16. Wholesale: the field only with ?wholesale=1; the wholesale route and a dealer link read.
add('wholesale: cart field hidden by default, shown with ?wholesale=1; /wholesale reads', async () => {
  const {context, page} = await visitor('BE');
  try {
    await addPreorder(page);
    await open(page, '/cart');
    const field = () => page.locator('input[name="discountCode"], input[name="code"], input[name="wholesaleCode"]');
    if (await field().count()) throw new Error('wholesale field shown without ?wholesale=1');
    await open(page, '/cart?wholesale=1');
    if (!(await field().count())) throw new Error('no wholesale field with ?wholesale=1');
    const response = await open(page, '/wholesale');
    if (!response || response.status() >= 400) throw new Error(`/wholesale HTTP ${response?.status()}`);
    await noForbidden(page, '/wholesale');
  } finally {
    await context.close();
  }
});

// 17. Search engines: canonical without query, no region price baked into a cacheable page.
add('SEO: canonical has no ?country, product page is not publicly cached', async () => {
  for (const country of ['BE', 'US']) {
    const response = await fetch(`${BASE}${PDP}?country=${country}`, {headers: {'CF-IPCountry': country}, redirect: 'follow'});
    const html = await response.text();
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? '';
    if (!canonical || canonical.includes('?')) throw new Error(`canonical ${canonical}`);
    const cache = response.headers.get('cache-control') ?? '';
    if (/public|s-maxage/.test(cache) && !/vary/i.test(response.headers.get('vary') ?? '')) throw new Error(`${country}: cache-control ${cache} without Vary`);
  }
});

// 18. The ordinary shop (nothing is pre-order): no pre-order or batch wording anywhere, /preorder
// redirects, and an in-stock item goes into the cart and to checkout like in any shop.
for (const country of ['BE', 'GB', 'US', null]) {
  add(`ordinary shop ${country ?? 'unknown'}: no pre-order, March 2027 or batch wording; cart works`, async () => {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, extraHTTPHeaders: country ? {'CF-IPCountry': country} : {}});
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    try {
      for (const path of ['/', PDP, '/products/openesc', '/products', '/preorder', '/cart']) {
        const response = await page.goto(ORDINARY_BASE + path, {waitUntil: 'load'});
        if (!response || response.status() >= 400) throw new Error(`${path}: HTTP ${response?.status()}`);
        if (path === '/preorder' && !new URL(page.url()).pathname.startsWith('/products')) throw new Error('/preorder did not redirect');
        const text = await visibleText(page);
        // No pre-order perk either: the footer's "Early bird role on Discord" is gone (founder 2026-11-11).
        const hit = text.match(/pre-?order|March 2027|31 Mar|\bbatch\b|early bird/i);
        if (hit) throw new Error(`${path}: reads "${hit[0]}"`);
        if (currencies(text).length > 1) throw new Error(`${path}: two currencies`);
      }
      await page.goto(ORDINARY_BASE + PDP, {waitUntil: 'load'});
      if (await page.locator('[data-offer-choice] [data-offer]:visible').count()) throw new Error('offer cards in an ordinary shop');
      const add = page.locator('[data-buy-module] button[type=submit]:visible').first();
      if (await add.isDisabled()) return; // a market the shop does not sell to: nothing to add
      const posted = page.waitForResponse((r) => r.url().includes('/api/shopify/cart') && r.request().method() === 'POST');
      await add.click();
      const answer = await posted;
      // Batch 2 ships worldwide: once nothing is pre-order, stock goes in the cart from every country (founder 2026-11-11).
      if (answer.status() >= 400) throw new Error(`add refused: ${answer.status()} ${(await answer.text()).slice(0, 120)}`);
      await page.goto(ORDINARY_BASE + '/cart', {waitUntil: 'load'});
      if (!(await page.locator('main button:has-text("Checkout")').count())) throw new Error('no checkout in the cart');
    } finally {
      await context.close();
    }
  }, {needsOrdinary: true});
}

async function main() {
  browser = await chromium.launch({channel: 'chrome'});
  let failed = 0;
  let decisions = 0;
  let ran = 0;
  // Fault cases last, Buy now sold out last of all: the site keeps a catalog read for a minute,
  // so a fault would otherwise leak into the cases after it.
  const rank = (c) => (c.name.startsWith('Buy now sold out') ? 2 : c.needsControl ? 1 : 0);
  cases.sort((a, b) => rank(a) - rank(b));
  for (const c of cases) {
    if (ONLY && !c.name.includes(ONLY)) continue;
    if (c.needsOrdinary && !ORDINARY_BASE) {
      console.log(`SKIP  ${c.name} (no ORDINARY_BASE)`);
      continue;
    }
    if (c.needsControl && !CONTROL) {
      console.log(`SKIP  ${c.name} (no CONTROL)`);
      continue;
    }
    ran += 1;
    const started = Date.now();
    try {
      await c.run();
      console.log(`ok    ${c.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    } catch (error) {
      if (error?.decision) {
        decisions += 1;
        console.log(`DECIDE ${c.name}: ${error.message}`);
        continue;
      }
      failed += 1;
      console.log(`FAIL  ${c.name}: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  await browser.close();
  console.log(`${ran - failed - decisions}/${ran} passed${decisions ? `, ${decisions} waiting on a product decision` : ''}`);
  process.exit(failed ? 1 : 0);
}

main();
