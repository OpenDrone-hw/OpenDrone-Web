// Browser layout guard for "buy now or pre-order" (BATCH_CHOICE on).
//
// Against a running build whose catalog holds the `Batch` variants, at a
// 390 px phone and five laptop sizes, it asserts:
//   1. at scroll position zero nothing of the page sits under the header
//      (product page, home, cart);
//   2. choosing "Pre-order" instead of "Buy now" moves and resizes nothing:
//      every block of the buy area, the pinned bar and the home build block
//      keeps its bounding box;
//   3. the pinned buy bar is one slim row and holds the switch, not the cards;
//   4. the home build block is inside the first screen, clear of the header,
//      and on a laptop clear of the centre of the 3D hero.
//
// Usage: BASE=http://localhost:3101 node scripts/choice-layout-check.mjs
// Chrome is used when Playwright has no bundled browser (CHANNEL=chrome).
import {chromium} from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3101';
const PDP = process.env.PDP || '/products/openfc-lite?Model=20%C3%9720&country=BE';
const SIZES = [[390, 844], [1024, 768], [1280, 800], [1280, 938], [1440, 900], [1512, 982]];
const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

const browser = await chromium.launch(process.env.CHANNEL === 'bundled' ? {} : {channel: process.env.CHANNEL || 'chrome'});

/** Bounding boxes of the named blocks, rounded, keyed by selector and index. */
const boxes = (page, selectors) =>
  page.evaluate((list) => {
    const out = {};
    for (const selector of list) {
      document.querySelectorAll(selector).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width || r.height) out[`${selector}#${i}`] = [r.left, r.top + scrollY, r.width, r.height].map((n) => Math.round(n));
      });
    }
    return out;
  }, selectors);

function same(where, before, after) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (!a || !b) fail(where, `${key} ${a ? 'disappeared' : 'appeared'} when the mode changed`);
    else if (a.some((n, i) => Math.abs(n - b[i]) > 1)) fail(where, `${key} moved or resized: [${a}] -> [${b}]`);
  }
}

/** Nothing of the page's own content under the fixed header at scroll zero. */
async function clearOfHeader(page, where, selectors) {
  const hit = await page.evaluate((list) => {
    const bar = document.querySelector('.site-header-main') ?? document.querySelector('.site-header');
    const h = bar.getBoundingClientRect();
    const out = [];
    for (const selector of list) {
      for (const el of document.querySelectorAll(selector)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        if (r.top < h.bottom && r.bottom > h.top && r.left < h.right && r.right > h.left) out.push(`${selector} top ${Math.round(r.top)} under the header (bottom ${Math.round(h.bottom)})`);
      }
    }
    return out;
  }, selectors);
  for (const line of hit) fail(where, line);
}

const pick = (page, scope, offer) => page.locator(`${scope} [data-offer="${offer}"] input`).first().check({force: true});

for (const [width, height] of SIZES) {
  const phone = width < 500;
  const context = await browser.newContext({viewport: {width, height}, isMobile: phone, hasTouch: phone, reducedMotion: 'reduce'});
  const page = await context.newPage();
  const at = (name) => `${width}x${height} ${name}`;

  // Product page.
  await page.goto(BASE + PDP, {waitUntil: 'networkidle'}).catch(() => {});
  await page.waitForSelector('[data-offer-choice]', {timeout: 15000});
  await page.waitForTimeout(600);
  await clearOfHeader(page, at('product page'), ['h1', '.variant-ladder', '[data-offer-choice]', '.product-buy', '.product-hero-gallery-col img']);
  const buyArea = ['.variant-ladder', '.variant-tier', '.product-buy', '.product-buy-price', '[data-offer-choice]', '.offer-card', '.product-form', '.product-form .btn-primary', '[data-offer-status]', '.trust-chips', '.chapter'];
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (overflow > 0) fail(at('product page'), `page is ${overflow} px wider than the screen`);
  let before = await boxes(page, buyArea);
  await pick(page, '.product-hero', 'preorder').catch(() => pick(page, 'main', 'preorder'));
  await page.waitForTimeout(250);
  same(at('product page'), before, await boxes(page, buyArea));
  const tile = await page.locator('.variant-tier.is-selected .variant-tier-price, .variant-tier[aria-pressed="true"] .variant-tier-price, .variant-tier[aria-checked="true"] .variant-tier-price').first().textContent().catch(() => null);
  const card = await page.locator('main [data-offer="preorder"] .offer-card-price').first().textContent();
  if (tile !== null && tile.trim() !== card.trim()) fail(at('product page'), `size tile shows ${tile} while Pre-order costs ${card}`);
  // One type scale with the size tiles: the card title is the tile label's size, the lines are smaller.
  const type = await page.evaluate(() => {
    const px = (s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize);
    return {tile: px('.product-hero-copy .variant-tier-name'), title: px('main .offer-card-title'), line: px('main .offer-card-line')};
  });
  if (type.title !== type.tile || type.line >= type.title) fail(at('product page'), `offer card type is off the tile scale: ${JSON.stringify(type)}`);
  const wrapped = await page.evaluate(() => [...document.querySelectorAll('main .offer-card-line')].filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
  if (wrapped.length) fail(at('product page'), `offer card lines cut: ${wrapped.join(' | ')}`);

  // Pinned bar: one row, the switch and the button.
  await page.evaluate(() => scrollTo(0, 1600));
  await page.waitForSelector('.buy-rail.is-pinned', {timeout: 8000}).catch(() => fail(at('pinned bar'), 'the pinned bar did not show'));
  await page.waitForTimeout(500);
  const pinnedParts = ['.buy-rail.is-pinned', '.buy-rail.is-pinned .offer-card', '.buy-rail.is-pinned .btn-primary', '.buy-rail.is-pinned .variant-tier'];
  before = await boxes(page, pinnedParts);
  const bar = before['.buy-rail.is-pinned#0'];
  if (bar && bar[3] > 64) fail(at('pinned bar'), `the bar is ${bar[3]} px tall, more than one row`);
  const lines = await page.locator('.buy-rail.is-pinned .offer-card-line:visible').count();
  if (lines) fail(at('pinned bar'), 'the full offer cards show in the pinned bar');
  const [first, second] = [before['.buy-rail.is-pinned .offer-card#0'], before['.buy-rail.is-pinned .offer-card#1']];
  if (first && second && Math.abs(first[1] - second[1]) > 1) fail(at('pinned bar'), 'the two switch segments are stacked, not side by side');
  await pick(page, '.buy-rail.is-pinned', 'buy_now');
  await page.waitForTimeout(250);
  same(at('pinned bar'), before, await boxes(page, pinnedParts));

  // Home build block.
  await page.goto(`${BASE}/?country=BE`, {waitUntil: 'networkidle'}).catch(() => {});
  await page.waitForSelector('.hero-build-choice', {timeout: 20000});
  await page.waitForTimeout(phone ? 600 : 2500);
  await clearOfHeader(page, at('home'), ['.hero-build-choice', '.home-mobile-hero a', '.home-mobile-hero h1', '.hero-size-toggle']);
  const homeParts = ['.hero-build-choice', '.hero-choice-option', '.hero-build-part', '.hero-build-buy', '.hero-build-add', '.hero-build-status', '.home-mobile-featured'];
  before = await boxes(page, homeParts);
  await page.locator('.hero-choice-option input').nth(1).check({force: true});
  await page.waitForTimeout(250);
  same(at('home'), before, await boxes(page, homeParts));
  const block = before['.hero-build-choice#0'];
  if (!phone && block) {
    if (block[1] + block[3] > height) fail(at('home'), `the build block ends at ${block[1] + block[3]} px, under the fold`);
    if (block[0] < width / 2 + 40) fail(at('home'), `the build block starts at x ${block[0]}, over the centre of the hero`);
    const type = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.hero-build-choice .hero-build-name strong')).fontSize));
    if (type < 14) fail(at('home'), `part names are ${type} px`);
  }
  await context.close();
}
await browser.close();

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`\n${failures.length} layout failure(s)`);
  process.exit(1);
}
process.stdout.write(`choice layout: ${SIZES.length} sizes, no page content under the header at scroll zero, no shift between the two modes\n`);
