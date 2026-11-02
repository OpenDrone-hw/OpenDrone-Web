import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('phones get the availability card in the page flow, never as a fixed overlay', () => {
  const css = read('../styles/site-ui.css');
  const phone = css.indexOf('@media (max-width: 768px), (max-height: 500px) and (orientation: landscape) {\n  .avail-banner:not(.avail-banner--inline)'.replace(/\n/g, css.includes('\r\n') ? '\r\n' : '\n'));
  assert.ok(phone > 0, 'phone query hides the fixed card');
  assert.match(css.slice(phone), /\.avail-banner\.avail-banner--inline \{ display: flex; position: static;/);
  assert.match(css, /\n\.avail-banner--inline \{ display: none; \}/, 'inline card hidden off phones');
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
