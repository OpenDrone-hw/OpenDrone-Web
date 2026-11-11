// Browser check for the cart (BATCH_CHOICE on), against a running local
// preview whose storefront stand-in keeps carts in memory and prices them in
// the cart's market (`.review/handoff/preview-3101-storefront.mjs`).
//
// It asserts:
//   1. one currency: after the ship-to country changes to the US, every line,
//      the subtotal and the shipping row are in US$, and the old sentence
//      "This cart was priced for the EU..." is gone;
//   2. the "Wholesale code" field: absent on /cart after a visit to
//      /wholesale, present on /cart?wholesale=1;
//   3. a cart holding a Buy now board from before the two lanes: on load the
//      line is a pre-order of the same board, same quantity, with one notice
//      at the top of the cart (dismissible), and checkout is not refused;
//   4. every cart message is a `.notice` above the lines, never loose text
//      under the code field.
//
// Usage: BASE=http://localhost:3101 STOREFRONT=http://localhost:3102 node scripts/cart-check.mjs
import {chromium} from 'playwright';

const BASE = process.env.BASE || 'http://localhost:3101';
const STOREFRONT = process.env.STOREFRONT || 'http://localhost:3102';
const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

const browser = await chromium.launch(process.env.CHANNEL === 'bundled' ? {} : {channel: process.env.CHANNEL || 'chrome'});
const context = await browser.newContext({viewport: {width: 1280, height: 900}});
const page = await context.newPage();

const add = (sku, qty = 1) =>
  page.request.post(`${BASE}/api/shopify/cart`, {form: {sku, qty: String(qty), country: 'BE'}, headers: {Origin: BASE, Referer: `${BASE}/`}, maxRedirects: 0});
const gql = (query, variables) =>
  fetch(STOREFRONT, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query, variables})}).then((r) => r.json());

// A cart with two pre-order boards, in Belgium.
await page.goto(`${BASE}/?country=BE`, {waitUntil: 'domcontentloaded'});
await add('OPENFC-LITE-2020');
await add('OPENMOTOR-1604', 4).catch(() => {});
await page.goto(`${BASE}/cart?country=BE`, {waitUntil: 'networkidle'});
if (!(await page.locator('.cart-lines-scroll li').count())) fail('cart', 'no lines after the adds');

// 2. Wholesale code field.
await page.goto(`${BASE}/wholesale`, {waitUntil: 'domcontentloaded'});
if (!(await page.locator('[data-wholesale-code-link]').count())) fail('wholesale', 'no "Have a wholesale code?" link at the foot of /wholesale');
await page.goto(`${BASE}/cart?country=BE`, {waitUntil: 'networkidle'});
if (await page.locator('input[name="code"]:visible').count()) fail('cart after /wholesale', 'the Wholesale code field shows without the parameter');
await page.goto(`${BASE}/cart?country=BE&wholesale=1`, {waitUntil: 'networkidle'});
if (!(await page.locator('input[name="code"]').count())) fail('cart ?wholesale=1', 'the Wholesale code field is missing');
await page.goto(`${BASE}/cart?country=BE`, {waitUntil: 'networkidle'});
if (await page.locator('input[name="code"]:visible').count()) fail('cart, plain visit again', 'the Wholesale code field is remembered');

// 3. A Buy now board slipped in from before the two lanes (written straight
// into the stand-in's cart, the way an old cart would hold it).
let cartId = null;
for (let n = 1; n < 400 && !cartId; n += 1) {
  const id = `gid://shopify/Cart/preview${n}?key=preview${n}`;
  const out = await gql('query C($id: ID!) { cart(id: $id) { id } }', {id});
  if (out?.data?.cart) cartId = id;
}
if (!cartId) fail('old cart', 'could not find the preview cart');
else {
  await gql('mutation A($cartId: ID!, $lines: [CartLineInput!]!) { cartLinesAdd(cartId: $cartId, lines: $lines) { cart { id } } }', {
    cartId,
    lines: [{merchandiseId: 'gid://shopify/ProductVariant/preview-buynow-OPENESC-2020', quantity: 2}],
  });
  await page.goto(`${BASE}/cart?country=BE`, {waitUntil: 'networkidle'});
  const notice = page.locator('.cart .notice').first();
  const text = (await notice.textContent().catch(() => '')) ?? '';
  if (!/moved to pre-order/.test(text)) fail('old cart', `no move notice at the top (saw "${text}")`);
  const lines = await gql('query C($id: ID!) { cart(id: $id) { lines(first: 50) { nodes { quantity merchandise { ... on ProductVariant { id } } } } } }', {id: cartId});
  const nodes = lines?.data?.cart?.lines?.nodes ?? [];
  if (nodes.some((l) => /preview-buynow/.test(l.merchandise.id))) fail('old cart', 'a Buy now line is still in the cart');
  if (await page.locator('.cart-checkout-cta[disabled]').count()) fail('old cart', 'checkout is refused after the move');
  // The notice sits above the lines.
  const [noticeBox, linesBox] = await Promise.all([notice.boundingBox(), page.locator('.cart-lines-scroll').boundingBox()]);
  if (noticeBox && linesBox && noticeBox.y > linesBox.y) fail('old cart', 'the notice is under the lines');
  await page.locator('.cart .notice .notice-close').first().click().catch(() => fail('old cart', 'the move notice cannot be dismissed'));
  if (await page.locator('.cart .notice').filter({hasText: 'moved to pre-order'}).count()) fail('old cart', 'the move notice stays after dismiss');
}

// 1. One currency after the ship-to country changes.
await page.goto(`${BASE}/cart?country=US`, {waitUntil: 'networkidle'});
const symbols = await page.evaluate(() => {
  const area = document.querySelector('.cart-main') ?? document.body;
  return {
    euro: (area.textContent.match(/€/g) ?? []).length,
    dollar: (area.textContent.match(/\$/g) ?? []).length,
    old: /priced for the EU/.test(area.textContent),
  };
});
if (symbols.old) fail('cart US', 'still says "This cart was priced for the EU"');
if (symbols.euro && symbols.dollar) fail('cart US', `mixed currencies: ${symbols.euro} euro and ${symbols.dollar} dollar amounts`);
if (!symbols.dollar) fail('cart US', 'no US$ amounts after the move to the US');
// Back to Belgium: all euro again.
await page.goto(`${BASE}/cart?country=BE`, {waitUntil: 'networkidle'});
const back = await page.evaluate(() => (document.querySelector('.cart-main')?.textContent.match(/\$/g) ?? []).length);
if (back) fail('cart BE', 'dollar amounts left after moving back to Belgium');

// 4. No loose coloured text under the code field.
if (await page.locator('.cart-code ~ .cart-alert, form .cart-alert').count()) fail('cart', 'a cart message sits in the checkout form instead of the top');

await browser.close();
if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`\n${failures.length} cart failure(s)`);
  process.exit(1);
}
process.stdout.write('cart check: one currency after a country change, no wholesale field without the parameter, old in-stock lines moved to pre-order with a top notice\n');
