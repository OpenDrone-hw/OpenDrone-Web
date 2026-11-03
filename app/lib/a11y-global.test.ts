import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('header: phone Menu toggle exposes aria-expanded and aria-controls', () => {
  const header = read('../components/Header.tsx');
  assert.match(header, /aria-expanded=\{type === 'mobile'\}\s+aria-controls=\{MOBILE_DRAWER_ID\}/);
  assert.doesNotMatch(header, /<NavLink[^>]*aria-expanded/s);
});

test('EU bar dismiss moves focus to main instead of dropping it to body', () => {
  const banner = read('../components/AvailabilityBanner.tsx');
  assert.match(banner, /getElementById\('main-content'\)/);
  assert.match(banner, /main\.focus\(/);
});

test('footer: every nav is named; summary leaves the Tab order on wide screens', () => {
  const footer = read('../components/Footer.tsx');
  const navs = footer.match(/<nav\b[^>]*>/g) ?? [];
  assert.ok(navs.length >= 5);
  for (const n of navs) assert.match(n, /aria-label=/, n);
  assert.match(footer, /summary\.tabIndex = mq\.matches \? 0 : -1/);
  assert.match(footer, /e\.preventDefault\(\)/);
  assert.match(footer, /min-h-\[24px\]/);
  assert.doesNotMatch(footer, /md:min-h-0/);
});

test('newsletter: no empty h3, region always has a name', () => {
  const src = read('../components/NewsletterSignup.tsx');
  assert.match(src, /\{hasTitle \? \(\s+<h3/);
  assert.match(src, /'aria-label': regionLabel/);
  assert.equal((JSON.parse(read('../../content/copy/newsletter.json')) as Record<string, string>).signup_title, '');
});

test('site CSS: underlined inline links, new-tab notice, field borders >= 3:1', () => {
  const css = read('../styles/app.css');
  assert.match(css, /main :is\(p, li, dd, td, blockquote, figcaption\) a:not\(\[class\]\),\s+\.legal-body a \{\s+text-decoration: underline;/);
  assert.match(css, /a\[target='_blank'\]::after \{\s+content: ' \(opens in a new tab\)';/);
});

test('route changes move focus to main and announce the title; no-op on first load', () => {
  const src = read('../components/RouteAnnouncer.tsx');
  assert.match(src, /previous\.current === pathname\) return/);
  assert.match(src, /role="status" aria-live="polite"/);
  assert.match(src, /setMessage\(document\.title\)/);
  assert.match(read('../components/PageLayout.tsx'), /<RouteAnnouncer \/>/);
});

test('scroll-padding-top clears the strips and header; series rail number is full muted token at 12px', () => {
  assert.match(read('../styles/site-ui.css'), /html \{ scroll-padding-top: calc\(var\(--test-banner-h, 0px\) \+ var\(--avail-bar-h, 0px\) \+ var\(--header-height, 0px\)/);
  assert.match(read('../styles/app.css'), /\.series-rail-num \{\s+font-size: 12px;\s+letter-spacing: 0\.1em;\s+color: var\(--color-text-muted\);/);
});
