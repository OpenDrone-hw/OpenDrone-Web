// Single-shot mobile screenshot helper for visual review.
//   node scripts/shot.mjs <route> [scheme] [scrollY|selector] [outName] [device]
// Examples:
//   node scripts/shot.mjs / dark            -> .mobile-audit/shots/home-dark.png (full page)
//   node scripts/shot.mjs /products/openesc dark .board-art board-esc
//   node scripts/shot.mjs /products light 800
import {chromium, devices} from 'playwright';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3001';
const [route = '/', scheme = 'light', target, outName, devName = 'iPhone 13'] =
  process.argv.slice(2);
const OUT = path.resolve('.mobile-audit/shots');
await mkdir(OUT, {recursive: true});

const b = await chromium.launch();
const ctx = await b.newContext({...devices[devName], colorScheme: scheme});
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message.slice(0, 120)));
p.on('console', (m) => m.type() === 'error' && errs.push('console: ' + m.text().slice(0, 120)));
await p.goto(BASE + route, {waitUntil: 'domcontentloaded', timeout: 30000});
await p.waitForTimeout(2200);
// Trigger lazy media by stepping down the page, then return to top.
await p.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 500) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 90));
  }
  window.scrollTo(0, 0);
});
await p.waitForTimeout(800);

const safe = (route === '/' ? 'home' : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, ''));
const file = path.join(OUT, `${outName || safe}-${scheme}.png`);

let shotEl = null;
if (target && /^\d+$/.test(target)) {
  await p.evaluate((y) => window.scrollTo(0, +y), target);
  await p.waitForTimeout(500);
} else if (target) {
  shotEl = await p.$(target);
  if (shotEl) await shotEl.scrollIntoViewIfNeeded();
  await p.waitForTimeout(1500);
}

if (shotEl) await shotEl.screenshot({path: file});
else await p.screenshot({path: file, fullPage: !target});

console.log(`wrote ${file}${errs.length ? `  ERRORS: ${errs.slice(0, 3).join(' | ')}` : '  (no errors)'}`);
await b.close();
