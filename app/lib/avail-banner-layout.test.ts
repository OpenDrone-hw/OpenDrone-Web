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
