// Stills of the homepage walkthrough for the phone layout, which never loads
// the 3D. One transparent WebP per step (public/models/<design>/tour/<id>.webp),
// rendered by the live scene at each step's stop, so the phone shows the same
// drone the desktop walkthrough does.
//
// Needs a running dev server and cwebp:
//   npm run dev
//   BASE=http://localhost:5173 npm run gen:tour-stills
//
// STAGING_PASSWORD (environment or .env) is sent when the dev server asks
// for it. PW_CHANNEL=chrome uses the installed Chrome instead of Playwright's
// bundled Chromium.
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:5173';
const DESIGN = process.env.DESIGN || 'od3';
// The phone stage's aspect (.tour-m-stage, 1 / 0.82).
const W = 900;
const H = 738;
const OUT = path.resolve('public/models', DESIGN, 'tour');

const guard = setTimeout(() => {
  console.error('capture-tour-stills: timed out after 5 minutes');
  process.exit(2);
}, 5 * 60 * 1000);
guard.unref();

function stagingPassword() {
  if (process.env.STAGING_PASSWORD) return process.env.STAGING_PASSWORD.trim();
  if (!existsSync('.env')) return '';
  const m = /^STAGING_PASSWORD=(.*)$/m.exec(readFileSync('.env', 'utf8'));
  return (m?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
}

const pw = stagingPassword();
const browser = await chromium.launch({
  channel: process.env.PW_CHANNEL || undefined,
  args: ['--ignore-gpu-blocklist', '--enable-gpu'],
});
try {
  const ctx = await browser.newContext({
    viewport: {width: W, height: H},
    deviceScaleFactor: 1,
    ...(pw ? {httpCredentials: {username: 'opendrone', password: pw}} : {}),
  });
  // Frame for the phone, whatever the desktop caption column wants: the drone
  // centred whole, and a part a little left of centre with the dimmed drone
  // beside it.
  await ctx.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const st = document.createElement('style');
      st.textContent =
        '.hp-stage{--hero-shift-x:0.05!important;--hero-shift-x-part:0.2!important;--hero-shift-y:-0.02!important;--hero-zoom:1.1!important}';
      document.head.append(st);
    });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  await page.goto(`${BASE}/hero-preview?herotest`, {waitUntil: 'load'});
  await page.waitForFunction(() => window.__hero, null, {timeout: 90000});
  const steps = await page.evaluate(() => window.__hero.steps);
  mkdirSync(OUT, {recursive: true});
  for (let i = 0; i < steps.length; i++) {
    const png = await page.evaluate((i) => {
      const h = window.__hero;
      h.goTo(i);
      // Past travel and the part's minimum dwell, spring settled.
      h.step(420);
      return h.snap();
    }, i);
    const tmp = path.join(OUT, `${steps[i]}.png`);
    writeFileSync(tmp, Buffer.from(png.split(',')[1], 'base64'));
    execFileSync('cwebp', ['-quiet', '-q', '80', '-alpha_q', '90', '-m', '6', tmp, '-o', path.join(OUT, `${steps[i]}.webp`)]);
    rmSync(tmp);
    process.stdout.write(`${steps[i]}.webp\n`);
  }
} finally {
  await browser.close();
}
process.exit(0);
