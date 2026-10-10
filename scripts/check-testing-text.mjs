#!/usr/bin/env node
/**
 * Checks of the /testing report in a real browser.
 *
 *   text      at most BUDGET visible words (document.body.innerText after the
 *             page has been scrolled through, so charts are mounted; closed
 *             <details> and SVG text are not visible and not counted), no em
 *             dash, no blockquote
 *   layout    no page-level horizontal scroll at 390 and 1440 px
 *   links     every in-page link has a target
 *   charts    every figure mounts one focusable chart
 *   console   no error (the dev-only critical.css nonce warning of React
 *             Router is ignored; it also appears on every other route and
 *             is absent from a production build)
 *
 *   node scripts/check-testing-text.mjs [url]   (default http://localhost:5199/testing)
 *
 * Needs Playwright with a browser: the bundled one, else installed Chrome.
 */
import {chromium} from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5199/testing';
// A report: every note of every figure and the whole log are on the page.
const BUDGET = 3000;

async function launch() {
  try {
    return await chromium.launch();
  } catch {
    return chromium.launch({channel: 'chrome'});
  }
}

const browser = await launch();
const problems = [];
let words = 0;

for (const width of [1440, 390]) {
  const page = await browser.newPage({viewport: {width, height: width === 390 ? 844 : 900}});
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/critical\.css|data-react-router-critical-css/.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message.slice(0, 200)}`));
  await page.goto(url, {waitUntil: 'networkidle'});
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 70));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const text = document.body.innerText;
    const ids = new Set([...document.querySelectorAll('[id]')].map((e) => e.id));
    const dead = [...document.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)).filter((h) => h && !ids.has(h));
    return {
      text,
      scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dead: [...new Set(dead)],
      charts: document.querySelectorAll('.tw-chart[tabindex="0"]').length,
      figures: document.querySelectorAll('.tr-fig[id]').length,
      // The first plot is drawn whole once mounted: ink in its left third as well as its right.
      painted: (() => {
        const c = document.querySelector('.tw-chart canvas');
        if (!c) return false;
        const ctx = c.getContext('2d');
        const h = c.height;
        const third = Math.floor(c.width / 3);
        const has = (x0) => ctx.getImageData(x0, 0, third, h).data.some((v, i) => i % 4 === 3 && v > 0);
        return has(0) && has(c.width - third);
      })(),
      em: /—/.test(text),
      quote: document.querySelectorAll('blockquote').length,
    };
  });
  if (width === 1440) words = r.text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  if (r.scroll > 0) problems.push(`${width}px: page scrolls sideways by ${r.scroll}px`);
  if (r.dead.length) problems.push(`${width}px: links without a target: ${r.dead.join(', ')}`);
  if (r.charts !== r.figures) problems.push(`${width}px: ${r.charts} focusable charts for ${r.figures} figures`);
  if (!r.painted) problems.push(`${width}px: the first plot is not drawn across its width`);
  if (r.em) problems.push('em dash in the page');
  if (r.quote) problems.push('blockquote in the page');
  for (const e of errors) problems.push(`${width}px console error: ${e}`);
  await page.close();
}
await browser.close();

console.log(`visible words: ${words} / ${BUDGET}`);
if (words > BUDGET) problems.push(`${words} visible words, budget ${BUDGET}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('layout, links, charts and console: ok');
