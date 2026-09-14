// Mobile rendering audit harness.
// Loads each route under real device emulation (viewport + DPR + UA + touch)
// and captures full-page screenshots, horizontal-overflow offenders, and console errors.
//
// Usage:
//   node scripts/mobile-shots.mjs                 # all routes, iphone + pixel
//   node scripts/mobile-shots.mjs home products   # only matching route names
//   BASE=http://localhost:3001 node scripts/mobile-shots.mjs
import {chromium, devices} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:3001';
const OUT = path.resolve('.mobile-audit');

// iPhone SE first: 375px is the narrowest mainstream phone and the harshest
// test — if a layout holds at 375 it holds everywhere above it.
const DEVICES = [
  ['iphone-se', devices['iPhone SE']],
  ['iphone13', devices['iPhone 13']],
  ['pixel7', devices['Pixel 7']],
];

const ROUTES = [
  ['home', '/'],
  ['collections', '/collections'],
  ['catalog', '/products'],
  ['product-openframe', '/products/openframe'], // FrameViewer (touch drag)
  ['product-openstack', '/products/openstack'], // BoardArt + FirmwareSplit + Schematic
  ['product-openesc', '/products/openesc'], // BoardArt (ESC)
  ['product-battery-strap', '/products/battery-strap'], // simple product
  ['search', '/search?q=esc'],
  ['support', '/support'],
  ['contact', '/contact'],
  ['newsletter', '/newsletter'],
  ['legal', '/legal'],
  ['open-source', '/open-source'],
  ['firmware-partners', '/firmware-partners'],
];

// In-page audit: horizontal overflow offenders, sub-44px tap targets, and
// sub-12px text. Runs in the page so it measures the real laid-out boxes.
const AUDIT_PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const docW = document.documentElement.scrollWidth;
  const desc = (el) => {
    const cls = (el.className && el.className.toString && el.className.toString().slice(0, 60)) || '';
    return {tag: el.tagName.toLowerCase(), cls};
  };

  // 1. Horizontal overflow — elements poking past the viewport edge. Skip
  // position:fixed and fully off-canvas drawers (Aside panels parked at
  // translateX(100%) sit entirely right of the viewport and don't cause page
  // scroll) — those are false positives that mask the real in-flow culprit.
  const overflow = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).position === 'fixed') continue; // sticky chrome, not page flow
    if (r.left >= vw) continue; // entirely off the right edge — parked drawer
    if (r.right > vw + 1 || r.left < -1) {
      overflow.push({...desc(el), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width)});
    }
  }
  const seenO = new Set();
  const offenders = overflow
    .sort((a, b) => b.right - a.right)
    .filter((o) => { const k = o.tag + o.cls; if (seenO.has(k)) return false; seenO.add(k); return true; })
    .slice(0, 12);

  // 2. Tap targets — interactive elements smaller than 44x44 (Apple HIG / WCAG 2.5.5).
  // Inline anchors inside running text are exempt (WCAG 2.5.5 inline exception),
  // so skip display:inline links. Region-tag the rest: header/footer is shared
  // chrome (fix once), everything else is page-specific.
  const MIN_TAP = 44;
  const interactive = 'a, button, input, select, textarea, [role="button"], [role="link"], [onclick]';
  const region = (el) => el.closest('header') ? 'chrome' : el.closest('footer') ? 'chrome' : 'body';
  const small = [];
  const seenT = new Set();
  for (const el of document.querySelectorAll(interactive)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // hidden / collapsed
    if (getComputedStyle(el).display === 'inline') continue; // inline text link — exempt
    if (r.width < MIN_TAP || r.height < MIN_TAP) {
      const d = desc(el);
      const k = d.tag + d.cls + Math.round(r.width) + Math.round(r.height);
      if (seenT.has(k)) continue; seenT.add(k);
      small.push({...d, region: region(el), w: Math.round(r.width), h: Math.round(r.height),
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)});
    }
  }
  const tapTargetsTotal = small.length;
  const tapTargetsBody = small.filter((t) => t.region === 'body').length;
  const tapTargets = small.slice(0, 20);

  // 3. Tiny text — rendered font-size under 12px on elements with actual text.
  const MIN_FONT = 12;
  const tiny = [];
  const seenF = new Set();
  for (const el of document.querySelectorAll('p, span, a, li, td, th, label, button, h1, h2, h3, h4, h5, h6, small, div')) {
    const txt = el.textContent && el.textContent.trim();
    if (!txt) continue;
    // only leaf-ish text nodes — skip containers whose text comes from children
    if (el.children.length && !Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs && fs < MIN_FONT) {
      const d = desc(el);
      const k = d.tag + d.cls + Math.round(fs);
      if (seenF.has(k)) continue; seenF.add(k);
      tiny.push({...d, region: region(el), px: Math.round(fs * 10) / 10, sample: txt.slice(0, 30)});
    }
  }
  const tinyTextTotal = tiny.length;
  const tinyTextBody = tiny.filter((t) => t.region === 'body').length;
  const tinyText = tiny.slice(0, 15);

  return {vw, docW, horizontalScroll: docW > vw + 1, offenders,
    tapTargets, tapTargetsTotal, tapTargetsBody,
    tinyText, tinyTextTotal, tinyTextBody};
})()`;

const filter = process.argv.slice(2);
const routes = filter.length
  ? ROUTES.filter(([name]) => filter.some((f) => name.includes(f)))
  : ROUTES;

const report = {};

const browser = await chromium.launch();
for (const [devName, devCfg] of DEVICES) {
  await mkdir(path.join(OUT, devName), {recursive: true});
  const ctx = await browser.newContext({...devCfg});
  for (const [name, route] of routes) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 200)));
    const key = `${devName}/${name}`;
    try {
      await page.goto(BASE + route, {waitUntil: 'domcontentloaded', timeout: 30000});
      await page.waitForTimeout(2500); // settle: fonts, hydration, intersection observers
      const probe = await page.evaluate(AUDIT_PROBE);
      await page.screenshot({path: path.join(OUT, devName, name + '.png'), fullPage: true});
      report[key] = {route, ...probe, errors};
      const bits = [];
      if (probe.horizontalScroll) bits.push(`OVERFLOW docW=${probe.docW} vw=${probe.vw}`);
      if (probe.tapTargetsBody) bits.push(`tap=${probe.tapTargetsBody}(+${probe.tapTargetsTotal - probe.tapTargetsBody} chrome)`);
      if (probe.tinyTextBody) bits.push(`tiny=${probe.tinyTextBody}(+${probe.tinyTextTotal - probe.tinyTextBody} chrome)`);
      if (errors.length) bits.push(`errs=${errors.length}`);
      console.log(`${key.padEnd(34)} ${bits.length ? bits.join('  ') : 'ok'}`);
    } catch (e) {
      report[key] = {route, error: String(e).slice(0, 200)};
      console.log(`${key.padEnd(34)} FAILED ${String(e).slice(0, 120)}`);
    }
    await page.close();
  }
  await ctx.close();
}
await browser.close();
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

// Ranked markdown summary — aggregate every device's findings per page so the
// worst offenders float to the top. Severity: overflow is the most jarring on a
// phone (sideways scroll), then under-size tap targets, then tiny text.
const byPage = {};
for (const [key, r] of Object.entries(report)) {
  const [dev, name] = key.split('/');
  // Per-page body counts are the max across devices (not the sum) — the same
  // small button on 3 devices is one thing to fix, not three.
  const p = (byPage[name] ||= {name, route: r.route, overflow: 0, tap: 0, tiny: 0, errs: 0, devs: []});
  if (r.error) { p.failed = true; continue; }
  if (r.horizontalScroll) { p.overflow++; p.devs.push(dev); }
  p.tap = Math.max(p.tap, r.tapTargetsBody || 0);
  p.tiny = Math.max(p.tiny, r.tinyTextBody || 0);
  p.errs = Math.max(p.errs, (r.errors || []).length);
}
const score = (p) => p.overflow * 100 + p.tap * 5 + p.tiny + p.errs * 2;
const ranked = Object.values(byPage).sort((a, b) => score(b) - score(a));

let md = `# Mobile audit\n\nDevices: ${DEVICES.map(([n]) => n).join(', ')} · Base: ${BASE}\n`;
md += `\nCounts are page-body only (shared header/footer chrome excluded) and the worst across devices.\n\n`;
md += `| Page | Route | Overflow | Tap <44px | Tiny text | Errors |\n`;
md += `|------|-------|----------|-----------|-----------|--------|\n`;
for (const p of ranked) {
  const ov = p.failed ? 'FAILED' : p.overflow ? `⚠️ ${p.overflow}/${DEVICES.length}` : '—';
  md += `| ${p.name} | \`${p.route}\` | ${ov} | ${p.tap || '—'} | ${p.tiny || '—'} | ${p.errs || '—'} |\n`;
}
await writeFile(path.join(OUT, 'report.md'), md);

console.log('\nWrote screenshots + report.json + report.md to', OUT);
console.log('\nWorst-first (page body only):');
for (const p of ranked.slice(0, 12)) {
  console.log(`  ${p.name.padEnd(22)} overflow=${p.overflow} tap=${p.tap} tiny=${p.tiny} errs=${p.errs}`);
}
