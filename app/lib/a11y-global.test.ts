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
  // Zero specificity, so contextual text-decoration: none wins; never inside a nav.
  assert.match(css, /:where\(main :is\(p, li, dd, td, blockquote, figcaption\) a:not\(\[class\]\):not\(nav a\), \.legal-body a\) \{\s+text-decoration: underline;/);
  // Links whose own ::after draws something keep it; they carry an sr-only notice instead.
  assert.match(css, /a\[target='_blank'\]:not\(\.open-source-card, \.trust-chip-link\)::after \{\s+content: ' \(opens in a new tab\)';/);
  assert.doesNotMatch(css, /(^|\n)a\[target='_blank'\]::after/);
});

test('route changes move focus to main and announce the title; no-op on first load', () => {
  const src = read('../components/RouteAnnouncer.tsx');
  assert.match(src, /previous\.current === pathname\) return/);
  assert.match(src, /role="status" aria-live="polite"/);
  assert.match(src, /setMessage\(document\.title\)/);
  // Focus main OR announce, never both; never pull focus out of an open dialog (ChatFPV).
  assert.match(src, /closest\('\[role="dialog"\], dialog'\)/);
  assert.match(src, /main\.focus\(\{preventScroll: true\}\);\s+setMessage\(''\);\s+return;/);
  assert.match(read('../components/PageLayout.tsx'), /<RouteAnnouncer \/>/);
});

test('scroll-padding-top clears the strips and header; series rail number is full muted token at 12px', () => {
  assert.match(read('../styles/site-ui.css'), /html \{ scroll-padding-top: calc\(var\(--test-banner-h, 0px\) \+ var\(--avail-bar-h, 0px\) \+ var\(--header-height, 0px\)/);
  assert.match(read('../styles/app.css'), /\.series-rail-num \{\s+font-size: 12px;\s+letter-spacing: 0\.1em;\s+color: var\(--color-text-muted\);/);
});

test('reset.css declares Tailwind 4.3 properties layer first', () => {
  assert.match(read('../styles/reset.css'), /@layer properties, theme, base, reset-input, components, utilities;/);
});

test('excluded new-tab links carry the sr-only notice in markup', () => {
  const src = read('../routes/products.$handle.tsx');
  assert.equal((src.match(/className="open-source-card open-source-card--\w+"\n\s*>\n\s*<span className="sr-only">\{NEW_TAB_NOTE\}<\/span>/g) ?? []).length, 5);
  assert.match(src, /className="trust-chip trust-chip-oshwa trust-chip-link"[\s\S]{0,200}<span className="sr-only">\{NEW_TAB_NOTE\}<\/span>/);
});

test('one header offset: html scroll-padding-top, no scroll-margin-top on top of it', () => {
  for (const file of ['../styles/app.css', '../styles/site-ui.css']) {
    const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, /scroll-margin-top:/, file);
  }
});

test('cart: Remove moves focus only from body; copy keys for the announcements; busy country picker style', () => {
  const cart = read('../routes/cart.$.tsx');
  assert.match(cart, /const active = document\.activeElement;\s+if \(active && active !== document\.body\) return;/);
  const copy = JSON.parse(read('../../content/copy/cart.json')) as Record<string, string>;
  assert.equal(copy.line_removed, 'Removed {name}');
  assert.equal(copy.line_qty_announce, 'Quantity {count}, {name}');
  const css = read('../styles/app.css');
  assert.match(css, /\.country-picker\[aria-busy='true'\] \.country-picker-field/);
  assert.doesNotMatch(css, /\.country-picker-field:disabled/);
});
