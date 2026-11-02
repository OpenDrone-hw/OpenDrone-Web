import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the in-flow card is static at every width; phones never get the fixed card', () => {
  const css = read('../styles/site-ui.css');
  const phone = css.indexOf('@media (max-width: 768px), (max-height: 500px) and (orientation: landscape) {\n  .avail-banner:not(.avail-banner--inline)'.replace(/\n/g, css.includes('\r\n') ? '\r\n' : '\n'));
  assert.ok(phone > 0, 'phone query hides the fixed card');
  assert.match(css, /\.avail-banner\.avail-banner--inline \{\s+position: static;/, 'in-flow card is never fixed');
  assert.doesNotMatch(css, /\.avail-banner--inline \{ display: none; \}/, 'in-flow card shows at every width');
});

test('the in-flow card sits at the top of <main>, and under the hero on the phone homepage', () => {
  const layout = read('../components/PageLayout.tsx');
  const main = layout.indexOf('<main id="main-content"');
  assert.ok(layout.indexOf('<InlineAvailabilityBanner />', main) > main);
  assert.ok(layout.indexOf('<InlineAvailabilityBanner />', main) < layout.indexOf('{children}', main));
  const home = read('../components/MobileHome.tsx');
  const heroEnd = home.indexOf('</section>', home.indexOf('className="home-mobile-hero"'));
  const inline = home.indexOf('<InlineAvailabilityBanner />');
  assert.ok(inline > heroEnd && inline < home.indexOf('className="home-mobile-build"'));
});

test('the in-flow card keeps the /flash and /guides rule and reserves no bottom space', () => {
  const banner = read('../components/AvailabilityBanner.tsx');
  assert.match(banner, /if \(!root\?\.shopOpen \|\| availabilityBannerHiddenOn\(pathname\)\) return null;/);
  assert.match(banner, /if \(!el \|\| inline\) return;/);
});

test('the fixed (floating) card renders only on the homepage', () => {
  const layout = read('../components/PageLayout.tsx');
  assert.match(layout, /\{isHomepage && shopOpen && !availabilityBannerHiddenOn\(pathname\) \? <AvailabilityBanner geo=\{geo\} \/> : null\}/);
  assert.match(layout, /\{isHomepage \? null : <InlineAvailabilityBanner \/>\}/);
});

test('on the PDP the in-flow card starts on the product column, not the wider rail', () => {
  const css = read('../styles/site-ui.css');
  assert.match(css, /\.site-main:has\(> \.product-page\) > \.avail-banner\.avail-banner--inline \{\s+max-width: min\(40rem, var\(--rail-width\), 1102px\);\s+margin-left: calc\(\(100% - min\(var\(--rail-width\), 1102px\)\) \/ 2\);/);
  const app = read('../styles/app.css');
  assert.match(app, /\.product-page \{\s+width: min\(var\(--rail-width\), 1102px\);/, 'keep in step with the PDP column width');
});

test('the floating card moves by transform only (no top/bottom animation), eased, and snaps under reduced motion', () => {
  const css = read('../styles/site-ui.css');
  const block = css.slice(css.indexOf('.avail-banner {'), css.indexOf('}', css.indexOf('.avail-banner {')));
  assert.match(block, /transform: translate3d\(0, calc\(-1 \* var\(--avail-banner-lift, 0px\)\), 0\);/);
  assert.match(block, /transition: transform 2[0-5]0ms ease-out;/);
  assert.doesNotMatch(block, /bottom:[^;]*--avail-banner-lift/, 'the lift never feeds bottom (a layout property)');
  assert.doesNotMatch(css, /--avail-banner-lift[^;]*\)\s*\+\s*env/, 'no other rule puts the lift into bottom');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s+\.avail-banner \{ transition: none; \}/);
});

test('no layout shift from the card: the page room is a constant reserve from SSR, never measured', () => {
  const css = read('../styles/site-ui.css');
  const banner = read('../components/AvailabilityBanner.tsx');
  const layout = read('../components/PageLayout.tsx');
  const root = read('../root.tsx');
  assert.doesNotMatch(css, /body:has\(\.avail-banner\)/, 'no padding that appears or changes with the card');
  assert.doesNotMatch(banner, /--avail-banner-space/, 'nothing re-measures page space');
  assert.match(css, /\[data-avail-reserve\] \{ padding-bottom: calc\(var\(--avail-banner-reserve\)/);
  assert.match(layout, /data-avail-reserve=\{isHomepage && shopOpen && !availabilityBannerHiddenOn\(pathname\) \? '' : undefined\}/);
  assert.match(root, /\[data-avail-reserve\]\{padding-bottom:0!important\}/, 'a dismissed visitor gets no reserve from the first paint');
});

test('measurement is rAF-throttled and does every read before its single write', () => {
  const banner = read('../components/AvailabilityBanner.tsx');
  assert.match(banner, /if \(!frame\) frame = requestAnimationFrame\(measure\);/);
  const m = banner.slice(banner.indexOf('const measure = () => {'), banner.indexOf('const schedule'));
  const write = m.indexOf("el.style.setProperty('--avail-banner-lift'");
  assert.ok(write > 0);
  for (const read of ['getBoundingClientRect', 'getComputedStyle']) assert.ok(m.lastIndexOf(read) < write, `${read} before the write`);
  assert.equal(m.split('setProperty').length - 1, 1, 'one write');
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

test('no shift from the font swap: both cards have a fixed width and two-line labels a fixed column', () => {
  const css = read('../styles/site-ui.css');
  const fixed = css.slice(css.indexOf('.avail-banner {'), css.indexOf('}', css.indexOf('.avail-banner {')));
  assert.match(fixed, /width: min\(30rem, calc\(100vw - 2rem\)\);/);
  assert.doesNotMatch(css.slice(css.indexOf('.avail-banner.avail-banner--inline {')), /^\s*width: fit-content;/m);
  assert.match(css, /\.avail-banner\[data-lines="2"\] \.avail-banner-line \{\s+display: grid;\s+grid-template-columns: 10\.5rem 1fr;/);
});
