import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {availabilityBannerHiddenOn, geoBarText} from './geo-availability.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the availability bar is server-rendered on every page except /flash and /guides/*', () => {
  const layout = read('../components/PageLayout.tsx');
  assert.match(layout, /\{shopOpen && !availabilityBannerHiddenOn\(pathname\) \? \(?\s*<AvailabilityBar\s+geo=\{shipGeo \?\? geo\}[\s\S]*?\/>\s*\)? : null\}/);
  for (const p of ['/', '/products/openesc', '/support', '/cart', '/nl/products/openfc-lite']) assert.equal(availabilityBannerHiddenOn(p), false, p);
  for (const p of ['/guides', '/guides/flash', '/flash', '/fr/guides/flash-openfc/flash']) assert.equal(availabilityBannerHiddenOn(p), true, p);
  const banner = read('../components/AvailabilityBanner.tsx');
  assert.match(banner, /className="top-strip avail-bar"/);
});

test('bar text: the visitor line, both lines when unknown, and a shorter phone line', () => {
  assert.equal(geoBarText('eu', 'en', false), 'EU: In stock in Belgium, ships in a few working days');
  assert.equal(geoBarText('eu', 'en', true), 'EU: In stock, ships in days');
  assert.equal(geoBarText('fallback', 'en', false), 'EU: In stock in Belgium, ships in a few working days · Elsewhere: Pre-order, ships March 2027');
  assert.ok(geoBarText('eu', 'en', true).length < geoBarText('eu', 'en', false).length);
  const css = read('../styles/site-ui.css');
  assert.match(css, /\.avail-bar-short \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 768px\) \{\s+\.avail-bar-long \{ display: none; \}\s+\.avail-bar-short \{ display: inline; \}/);
});

test('a dismissed bar is never painted and reserves no height (pre-paint style)', () => {
  const root = read('../root.tsx');
  assert.match(root, /\.avail-bar\{display:none!important\}:root\{--avail-bar-h:0px!important\}/);
  const css = read('../styles/site-ui.css');
  // On :root, so html's scroll-padding-top reads it too.
  assert.match(css, /:root:has\(\.avail-bar\) \{ --avail-bar-h: 26px; \}/);
  assert.match(css, /:root:has\(\.test-banner\) \{ --test-banner-h: 26px; \}/);
  assert.match(css, /padding-top: calc\(var\(--test-banner-h, 0px\) \+ var\(--avail-bar-h, 0px\)\);/);
});

test('one strip style for the staging strip and the availability bar, stacked with a divider', () => {
  const css = read('../styles/site-ui.css');
  const root = read('../root.tsx');
  assert.match(root, /className="top-strip test-banner"/);
  assert.match(css, /\.avail-bar \{\s+top: var\(--test-banner-h, 0px\);/);
  assert.match(css, /body:has\(\.test-banner\) \.avail-bar \{\s+border-top: 1px solid/);
});

test('no floating card left: no lift, hysteresis, avoid markers or bottom reserve', () => {
  assert.equal(existsSync(new URL('./avail-banner-lift.ts', import.meta.url)), false);
  const files = ['../components/AvailabilityBanner.tsx', '../components/PageLayout.tsx', '../components/MobileHome.tsx', '../routes/_index.tsx', '../root.tsx', '../styles/site-ui.css'];
  for (const f of files) {
    const s = read(f);
    for (const bad of ['avail-banner-lift', 'data-avail-avoid', 'data-avail-reserve', 'avail-banner-reserve', 'avail-banner-space', 'stableBannerLift', 'InlineAvailabilityBanner', 'requestAnimationFrame', 'MutationObserver']) {
      if ((f.endsWith('_index.tsx') || f.endsWith('root.tsx')) && (bad === 'requestAnimationFrame' || bad === 'MutationObserver')) continue; // the 3D hero and the perf script have their own
      assert.ok(!s.includes(bad), `${f} still has ${bad}`);
    }
  }
});

test('sticky footer: the layout fills the viewport below the strips, main grows, the footer is last', () => {
  const css = read('../styles/site-ui.css');
  const layout = read('../components/PageLayout.tsx');
  assert.match(layout, /className=\{isHomepage \? 'site-layout homepage-layout' : 'site-layout'\}/);
  assert.match(css, /\.site-layout \{\s+display: flex;\s+flex-direction: column;\s+min-height: calc\(100vh - var\(--test-banner-h, 0px\) - var\(--avail-bar-h, 0px\)\);\s+min-height: calc\(100dvh/);
  assert.match(css, /\.site-layout > \.site-main \{\s+flex: 1 0 auto;/);
  assert.doesNotMatch(css, /footer[^{]*\{[^}]*position: fixed/);
});

test('no footer jump: the lazily loaded footer drawing has its box reserved with the board outline aspect', () => {
  const css = read('../styles/site-ui.css');
  const svg = read('../../public/boards/openfc-lite/board-lite.svg');
  const [, , w, h] = svg.match(/viewBox="([^"]+)"/)![1]!.split(/\s+/).map(Number) as [number, number, number, number];
  const pad = w * 0.18; // DrawingView: margins for the dimension line and its text
  const m = css.match(/\.footer-view-art \{ aspect-ratio: ([\d.]+) \/ ([\d.]+); \}/);
  assert.ok(m, '.footer-view-art reserves an aspect-ratio');
  assert.ok(Math.abs(Number(m[1]) / Number(m[2]) - (w + 2 * pad) / (h + 2.4 * pad)) < 0.001);
  const footer = read('../components/Footer.tsx');
  assert.match(footer, /viewBox=\{`\$\{o\.x - pad\} \$\{o\.y - pad\} \$\{o\.w \+ pad \* 2\} \$\{o\.h \+ pad \* 2\.4\}`\}/, 'same margins as the CSS reserve');
  assert.match(footer, /const pad = o \? o\.w \* 0\.18 : 0;/);
});
