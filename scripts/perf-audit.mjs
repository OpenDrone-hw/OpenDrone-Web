#!/usr/bin/env node
/**
 * Quantitative performance audit for opendrone.store surfaces.
 *
 * Drives a real Chromium via Playwright + CDP, optionally CPU-throttled to
 * emulate slow hardware, walks every user-facing surface, and measures:
 *  - navigation metrics (TTFB, FCP, LCP, CLS, domInteractive)
 *  - main-thread long tasks (count, total, worst) per scenario
 *  - frame cadence (avg/p95/worst frame ms, jank counts) during scripted
 *    scrolls and interactions
 *  - input responsiveness: Event Timing entries >= 40ms
 *  - console errors
 *
 * Usage:
 *   node scripts/perf-audit.mjs [--url http://localhost:3001] [--throttle 4]
 *     [--device "Pixel 7"|"iPhone SE"|"Moto G4"] [--network slow4g|fast3g]
 *     [--out perf-report.json] [--headed] [--scenario home,pdp,...]
 *
 * Two harnesses, one script:
 *   desktop  node scripts/perf-audit.mjs --throttle 4
 *            (1440x900 @2x, CPU 4x = a slow laptop; WebGL scenarios need --headed)
 *   mobile   node scripts/perf-audit.mjs --device "Pixel 7" --throttle 6 --network slow4g
 *            (real device descriptor: viewport, DPR, UA, touch; CPU 6x + slow 4G
 *            is a 2019-class Android on a weak connection)
 * --device switches the mobile-relevant scenarios (mobile, teardown, gallery)
 * to touch input and the desktop-only ones (home, drawer) skip themselves.
 * Every scenario also records transferred bytes by resource type.
 *
 * Baseline vs fix runs: keep the JSON reports and diff the numbers.
 *
 * CAVEAT: chrome-headless-shell exaggerates some WebGL costs - a first
 * canvas render can appear as a >1s "long task" that does not reproduce in
 * headed Chrome (verified on /products/openframe). For scenarios that mount
 * a WebGL canvas mid-scroll, confirm suspicious stalls with --headed before
 * chasing them.
 */
import {chromium, devices} from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')
    ? args[i + 1]
    : dflt;
};
const BASE = argVal('url', 'http://localhost:3001').replace(/\/$/, '');
const THROTTLE = Number(argVal('throttle', '1'));
const OUT = argVal('out', '');
const HEADED = args.includes('--headed');
const DEVICE = argVal('device', '');
const NETWORK = argVal('network', '');
// Chrome DevTools presets (down/up bytes per second, RTT ms).
const NETWORKS = {
  slow4g: {downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8, latency: 400},
  fast3g: {downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150},
};
if (NETWORK && !NETWORKS[NETWORK]) {
  console.error(`unknown --network ${NETWORK}; use ${Object.keys(NETWORKS).join('|')}`);
  process.exit(2);
}
if (DEVICE && !devices[DEVICE]) {
  console.error(`unknown --device "${DEVICE}"; Playwright knows e.g. "Pixel 7", "iPhone SE", "Moto G4", "Galaxy S9+"`);
  process.exit(2);
}
const ONLY = argVal('scenario', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** In-page measurement helpers, installed fresh on every navigation. */
const HARNESS = `(() => {
  if (window.__pa) return;
  const P = {longTasks: [], events: [], errors: [], cls: 0, lcp: 0};
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push({start: Math.round(e.startTime), dur: Math.round(e.duration)}); }).observe({type: 'longtask', buffered: true}); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration >= 40) P.events.push({name: e.name, dur: Math.round(e.duration), t: Math.round(e.startTime)}); }).observe({type: 'event', durationThreshold: 40, buffered: true}); } catch {}
  try { new PerformanceObserver((l) => { const es = l.getEntries(); if (es.length) P.lcp = Math.round(es[es.length - 1].startTime); }).observe({type: 'largest-contentful-paint', buffered: true}); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) P.cls += e.value; }).observe({type: 'layout-shift', buffered: true}); } catch {}
  P.mark = () => ({lt: P.longTasks.length, ev: P.events.length});
  P.since = (m) => {
    const lts = P.longTasks.slice(m.lt);
    return {
      longTasks: lts.length,
      longTaskTotalMs: lts.reduce((s, t) => s + t.dur, 0),
      longTaskWorstMs: lts.reduce((s, t) => Math.max(s, t.dur), 0),
      slowEvents: P.events.slice(m.ev),
    };
  };
  P.fps = (ms) => new Promise((res) => {
    const deltas = [];
    let last = 0, t0 = 0;
    const tick = (t) => {
      if (last) deltas.push(t - last);
      last = t;
      if (t - t0 < ms) requestAnimationFrame(tick);
      else {
        deltas.sort((a, b) => a - b);
        const avg = deltas.reduce((s, d) => s + d, 0) / (deltas.length || 1);
        res({
          frames: deltas.length,
          avgMs: +avg.toFixed(2),
          fps: Math.round(1000 / (avg || 1)),
          p95Ms: +(deltas[Math.floor(deltas.length * 0.95)] || 0).toFixed(1),
          worstMs: +(deltas[deltas.length - 1] || 0).toFixed(1),
          jank20: deltas.filter((d) => d > 20).length,
          jank34: deltas.filter((d) => d > 34).length,
          jank100: deltas.filter((d) => d > 100).length,
        });
      }
    };
    requestAnimationFrame((t) => { t0 = t; last = t; requestAnimationFrame(tick); });
  });
  P.sweep = (toY, ms) => new Promise((res) => {
    const fromY = window.scrollY;
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / ms);
      window.scrollTo(0, fromY + (toY - fromY) * t);
      if (t < 1) requestAnimationFrame(step);
      else res('done');
    };
    requestAnimationFrame(step);
  });
  P.nav = () => {
    const n = performance.getEntriesByType('navigation')[0];
    return {
      ttfb: n ? Math.round(n.responseStart) : null,
      domInteractive: n ? Math.round(n.domInteractive) : null,
      fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0),
      lcp: P.lcp,
      cls: +P.cls.toFixed(4),
    };
  };
  window.__pa = P;
})();`;

/** Measure fps while an in-page action runs; returns fps + longtask delta. */
async function measure(page, label, fn, ms = 3000) {
  const m = await page.evaluate(() => window.__pa.mark());
  const fpsP = page.evaluate((d) => window.__pa.fps(d), ms);
  const t0 = Date.now();
  await fn();
  const actionMs = Date.now() - t0;
  const fps = await fpsP;
  const delta = await page.evaluate((mm) => window.__pa.since(mm), m);
  return {step: label, actionMs, ...fps, ...delta};
}

async function idle(page, ms) {
  await page.evaluate((d) => new Promise((r) => setTimeout(r, d)), ms);
}

/** Click via real input events at the element's center. */
async function click(page, selector, opts = {}) {
  const el = page.locator(selector).first();
  await el.waitFor({state: 'visible', timeout: 8000});
  await el.click({timeout: 8000, ...opts});
}

const scenarios = {
  /** Homepage: splash -> hero scroll choreography -> size toggle. */
  async home(page, report) {
    const t0 = Date.now();
    await page.goto(BASE + '/', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    // Wait for the splash to release (skip button disappears / scroll unlocks)
    await page
      .waitForFunction(() => !document.querySelector('[data-splash], .splash-dim') || document.body.style.overflow !== 'hidden', null, {timeout: 25000})
      .catch(() => {});
    await idle(page, 1200);
    report.loadWallMs = Date.now() - t0;
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    // Load-phase long tasks (model fetch/decode/merge/compile all land here)
    const loadTasks = await page.evaluate(() => window.__pa.since({lt: 0, ev: 0}));
    report.steps.push({step: 'load-phase', ...loadTasks});
    report.steps.push(
      await measure(page, 'scroll-down', () => page.evaluate(() => window.__pa.sweep(document.documentElement.scrollHeight - innerHeight, 4000)), 4200),
    );
    report.steps.push(
      await measure(page, 'scroll-up', () => page.evaluate(() => window.__pa.sweep(0, 4000)), 4200),
    );
    report.steps.push(await measure(page, 'idle-hero', async () => idle(page, 2500), 2500));
    // Size toggle: first (may build model) then back (cached)
    const has3 = await page.locator('button:has-text("3″")').count();
    if (has3) {
      report.steps.push(await measure(page, 'size-toggle-first', () => click(page, 'button:has-text("3″")'), 3500));
      await idle(page, 800);
      report.steps.push(await measure(page, 'size-toggle-back', () => click(page, 'button:has-text("5″")'), 2500));
    }
    // Build-pipeline stage timings (hero:* performance.measure marks)
    report.heroStages = await page.evaluate(() =>
      performance
        .getEntriesByType('measure')
        .filter((m) => m.name.startsWith('hero:'))
        .map((m) => ({name: m.name, ms: Math.round(m.duration)})),
    );
  },

  /** Collections + catalog interactions. */
  async collections(page, report) {
    await page.goto(BASE + '/products', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 800);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    report.steps.push(
      await measure(page, 'scroll-down', () => page.evaluate(() => window.__pa.sweep(document.documentElement.scrollHeight - innerHeight, 3000)), 3200),
    );
    // Category filter chip (client-side filter)
    const chip = page.locator('a[href*="?category="], button[data-category], a[href*="category="]').first();
    if (await chip.count()) {
      report.steps.push(await measure(page, 'filter-click', () => chip.click(), 1500));
    }
    // Hover a product card (spotlight/quick-add reveal)
    const card = page.locator('a.product-card:visible, .product-card-link:visible').first();
    if (await card.count()) {
      report.steps.push(await measure(page, 'card-hover', () => card.hover(), 1200));
    }
  },

  /** PDP: gallery, variant pills, BoardArt layer rail, schematic, frame viewer. */
  async pdp(page, report) {
    await page.goto(BASE + '/products/openfc-lite', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 1200);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    report.steps.push(
      await measure(page, 'scroll-full', () => page.evaluate(() => window.__pa.sweep(document.documentElement.scrollHeight - innerHeight, 6000)), 6200),
    );
    report.steps.push(
      await measure(page, 'scroll-back-top', () => page.evaluate(() => window.__pa.sweep(0, 3000)), 3200),
    );
    // Variant pill click (server navigation)
    const pill = page.locator('[class*="option"] button, form a[href*="?"], button[aria-pressed]').first();
    if (await pill.count()) {
      report.steps.push(await measure(page, 'variant-click', () => pill.click().catch(() => {}), 2500));
    }
    // Gallery next arrow
    const arrow = page.locator('button[aria-label*="ext"], button[aria-label*="next"], button[aria-label*="Next"]').first();
    if (await arrow.count()) {
      report.steps.push(await measure(page, 'gallery-next', () => arrow.click().catch(() => {}), 1500));
    }
    // BoardArt layer rail stepping
    const layerBtn = page.locator('.board-art [class*="rail"] button, [class*="layer"] button').first();
    if (await layerBtn.count()) {
      await layerBtn.scrollIntoViewIfNeeded().catch(() => {});
      await idle(page, 600);
      report.steps.push(await measure(page, 'boardart-layer', () => layerBtn.click().catch(() => {}), 2000));
    }
  },

  /** The product listing: the closest thing to a cart page now that the
   *  cart itself lives on the shop. */
  async cart(page, report) {
    await page.goto(BASE + '/products', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 800);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    report.steps.push(
      await measure(page, 'scroll', () => page.evaluate(() => window.__pa.sweep(Math.min(600, document.documentElement.scrollHeight - innerHeight), 1500)), 1700),
    );
  },

  /** Search: the listing's client-side filter over the catalog. */
  async search(page, report) {
    await page.goto(BASE + '/products?q=open', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 600);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    const input = page.locator('input[type="search"]:visible').first();
    if (await input.count()) {
      // Count network requests fired while typing
      let fetches = 0;
      const onReq = (req) => { if (req.url().includes('predictive') || req.url().includes('/search')) fetches += 1; };
      page.on('request', onReq);
      report.steps.push(
        await measure(page, 'predictive-type', async () => {
          await input.click();
          await input.pressSequentially('openfc lite', {delay: 90});
          await idle(page, 900);
        }, 2400),
      );
      page.off('request', onReq);
      report.steps[report.steps.length - 1].searchFetches = fetches;
    }
  },

  /** Static/content pages incl. theme toggle cost. */
  async content(page, report) {
    await page.goto(BASE + '/blogs/news', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 600);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    const toggle = page.locator('button.theme-toggle:visible').first();
    if (await toggle.count()) {
      report.steps.push(await measure(page, 'theme-toggle', () => toggle.click().catch(() => {}), 1800));
      await idle(page, 400);
      report.steps.push(await measure(page, 'theme-toggle-back', () => toggle.click().catch(() => {}), 1800));
    }
    report.steps.push(
      await measure(page, 'scroll', () => page.evaluate(() => window.__pa.sweep(Math.min(1200, document.documentElement.scrollHeight - innerHeight), 1500)), 1700),
    );
  },

  /** Cart drawer open/close from a product page. */
  async drawer(page, report) {
    await page.goto(BASE + '/products/openesc', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 1000);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    const themeBtn = page.locator('button.theme-toggle:visible').first();
    if (await themeBtn.count()) {
      report.steps.push(await measure(page, 'theme-toggle', () => themeBtn.click(), 1500));
      await idle(page, 400);
      report.steps.push(await measure(page, 'theme-toggle-back', () => themeBtn.click(), 1500));
    }
  },

  /** Mobile viewport: MobileHome + touch-first surfaces. Under --device the
   *  context already IS the phone (UA, DPR, touch), which is the real path:
   *  the SSR picks MobileHome from the UA. Without --device this only
   *  narrows the desktop viewport, i.e. the resize path. */
  async mobile(page, report) {
    if (!DEVICE) await page.setViewportSize({width: 390, height: 844});
    try {
      await page.goto(BASE + '/', {waitUntil: 'domcontentloaded'});
      await page.evaluate(HARNESS);
      await idle(page, 2000);
      report.nav = await page.evaluate(() => window.__pa.nav());
      report.steps = [];
      report.steps.push(
        await measure(page, 'scroll-down', () => page.evaluate(() => window.__pa.sweep(document.documentElement.scrollHeight - innerHeight, 4000)), 4200),
      );
      await page.goto(BASE + '/products/openfc-lite', {waitUntil: 'domcontentloaded'});
      await page.evaluate(HARNESS);
      await idle(page, 1200);
      report.steps.push(
        await measure(page, 'pdp-scroll', () => page.evaluate(() => window.__pa.sweep(document.documentElement.scrollHeight - innerHeight, 5000)), 5200),
      );
    } finally {
      if (!DEVICE) await page.setViewportSize({width: 1440, height: 900});
    }
  },

  /** PDP teardown: fetch/parse of the board asset, the reveal, then a full
   *  layer sweep front -> back -> front, stepping via the deck dots (touch) or
   *  the rail (mouse). The sweep is where the phone stutter lived. */
  async teardown(page, report) {
    await page.goto(BASE + '/products/openesc', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 1200);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    const board = page.locator('.board-art').first();
    await board.waitFor({state: 'attached', timeout: 15000});
    report.steps.push(
      await measure(page, 'reveal', async () => {
        await board.evaluate((el) => el.scrollIntoView({block: 'center'}));
        await idle(page, 4500);
      }, 4700),
    );
    const sheets = await page.locator('.board-sheet').count();
    report.sheets = sheets;
    const step = async (i) => {
      const dot = page.locator('.board-art .board-deck-dot').nth(i);
      const rail = page.locator('.board-art .board-folder-rail button').nth(i);
      if (await dot.count() && (await dot.isVisible())) await dot.tap().catch(() => dot.click({force: true}));
      else if (await rail.count()) await rail.click({force: true}).catch(() => {});
      else await page.locator('.board-sheet').nth(i).click({force: true}).catch(() => {});
      await idle(page, 700);
    };
    report.steps.push(
      await measure(page, 'sweep-down', async () => {
        for (let i = 1; i < sheets; i++) await step(i);
      }, Math.max(2500, sheets * 750)),
    );
    report.steps.push(
      await measure(page, 'sweep-up', async () => {
        for (let i = sheets - 2; i >= 0; i--) await step(i);
      }, Math.max(2500, sheets * 750)),
    );
    // Part spotlight: first chip/pin lights a footprint (flip + highlight)
    const chip = page.locator('.board-part-chip:visible, .teardown-pin-hoverable:visible').first();
    if (await chip.count()) {
      report.steps.push(await measure(page, 'part-spotlight', () => chip.click({force: true}), 3000));
      report.steps.push(await measure(page, 'part-clear', () => chip.click({force: true}), 2500));
    }
  },

  /** PDP gallery: step through every photo and back to the first; a visited
   *  photo must come back without a refetch or a blur-up. */
  async gallery(page, report) {
    await page.goto(BASE + '/products/openrx', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 1500);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    const dots = page.locator('.product-gallery-deck .board-deck-dot');
    const n = await dots.count();
    report.images = n;
    // Count REFETCHES: a photo URL requested a second time. Fresh neighbour
    // warms are not refetches and are ignored.
    const seen = new Set();
    let refetches = 0;
    const onReq = (req) => {
      if (req.resourceType() !== 'image' || !/\/web\/image\//.test(req.url())) return;
      if (seen.has(req.url())) refetches += 1;
      else seen.add(req.url());
    };
    page.on('request', onReq);
    const go = async (i) => {
      const dot = dots.nth(i);
      if (await dot.isVisible()) await dot.click({force: true});
      else await page.locator('.product-gallery-thumb').nth(i).click({force: true}).catch(() => {});
      await idle(page, 600);
    };
    report.steps.push(await measure(page, 'step-forward', async () => { for (let i = 1; i < n; i++) await go(i); }, Math.max(2000, n * 650)));
    const before = refetches;
    report.steps.push(await measure(page, 'step-back', async () => { for (let i = n - 2; i >= 0; i--) await go(i); }, Math.max(2000, n * 650)));
    report.steps[report.steps.length - 1].imageRefetchesOnRevisit = refetches - before;
    page.off('request', onReq);
  },

  /** Client-side navigation between routes (SPA transitions). */
  async spanav(page, report) {
    await page.goto(BASE + '/products', {waitUntil: 'domcontentloaded'});
    await page.evaluate(HARNESS);
    await idle(page, 900);
    report.nav = await page.evaluate(() => window.__pa.nav());
    report.steps = [];
    const link = page.locator('a.product-card:visible, .product-card-link:visible').first();
    if (await link.count()) {
      report.steps.push(
        await measure(page, 'spa-to-pdp', async () => {
          await link.click();
          await page.waitForURL('**/products/**', {timeout: 8000}).catch(() => {});
          await idle(page, 1200);
        }, 3200),
      );
    }
  },
};

async function main() {
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-gpu', '--use-angle=metal', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
  const context = await browser.newContext(
    DEVICE
      ? {...devices[DEVICE]}
      : {viewport: {width: 1440, height: 900}, deviceScaleFactor: 2},
  );
  const page = await context.newPage();
  // Transfer accounting per scenario: bytes by resource type, from the
  // request sizes Playwright records (compressed body + headers).
  let bytes = {};
  page.on('requestfinished', (req) => {
    req.sizes().then((sz) => {
      const t = req.resourceType();
      bytes[t] = (bytes[t] || 0) + (sz.responseBodySize || 0);
    }).catch(() => {});
  });
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err).slice(0, 300)));

  const cdp = await context.newCDPSession(page);
  if (THROTTLE > 1) {
    await cdp.send('Emulation.setCPUThrottlingRate', {rate: THROTTLE});
  }
  if (NETWORK) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {offline: false, ...NETWORKS[NETWORK]});
  }

  const gpu = await (async () => {
    await page.goto('about:blank');
    return page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return 'none';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'masked';
    });
  })();

  const report = {
    base: BASE,
    throttle: THROTTLE,
    device: DEVICE || 'desktop 1440x900@2x',
    network: NETWORK || 'unthrottled',
    gpu,
    startedAt: new Date().toISOString(),
    scenarios: {},
  };

  // Desktop-only scenarios (mouse hover, WebGL hero) are skipped under a
  // phone descriptor; the rest run with touch where they tap.
  const DESKTOP_ONLY = new Set(['home', 'drawer', 'collections', 'search', 'content', 'spanav']);
  const names = (ONLY.length ? ONLY : Object.keys(scenarios)).filter(
    (n) => !(DEVICE && DESKTOP_ONLY.has(n) && !ONLY.length),
  );
  for (const name of names) {
    if (!scenarios[name]) {
      console.error(`unknown scenario: ${name}`);
      continue;
    }
    const sr = {};
    const t0 = Date.now();
    bytes = {};
    try {
      await scenarios[name](page, sr);
    } catch (err) {
      sr.error = String(err).slice(0, 400);
    }
    sr.wallMs = Date.now() - t0;
    sr.transferKB = Object.fromEntries(
      Object.entries(bytes).map(([k, v]) => [k, Math.round(v / 1024)]),
    );
    sr.transferKB.total = Math.round(Object.values(bytes).reduce((a, b) => a + b, 0) / 1024);
    report.scenarios[name] = sr;
    console.error(`- ${name} done in ${sr.wallMs}ms`);
  }

  report.consoleErrors = consoleErrors.slice(0, 30);
  await browser.close();

  const json = JSON.stringify(report, null, 2);
  if (OUT) fs.writeFileSync(OUT, json);
  console.log(json);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
