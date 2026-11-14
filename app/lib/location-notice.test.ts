import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {GEO_NOTICE_COPY, batchOnePromises, geoDeliveryLines, geoPreorderLine} from './geo-availability.ts';
import {nextLastSeen, noticeFor, noticeText} from './location-notice.ts';
import {parseCampaignConfig} from './preorder-campaign.ts';

const PREORDERS = parseCampaignConfig(JSON.parse(fs.readFileSync(new URL('../../content/preorders.json', import.meta.url), 'utf8')));
const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('noticeFor (when the location notice shows)', () => {
  it('never on a first visit: the country is only recorded', () => {
    assert.equal(noticeFor({lastSeen: null, current: 'BE', announced: null}), null);
    assert.equal(nextLastSeen(null, 'BE'), 'BE');
  });
  it('not for the same country, nor without one', () => {
    assert.equal(noticeFor({lastSeen: 'BE', current: 'BE', announced: null}), null);
    assert.equal(noticeFor({lastSeen: 'BE', current: null, announced: null}), null);
    assert.equal(nextLastSeen('BE', null), 'BE');
  });
  it('when the ordering country changes (the country picker in the header or the cart, ?country)', () => {
    assert.deepEqual(noticeFor({lastSeen: 'BE', current: 'GB', announced: null}), {country: 'GB', key: 'geo:BE>GB'});
    assert.deepEqual(noticeFor({lastSeen: 'be', current: 'de', announced: null}), {country: 'DE', key: 'geo:BE>DE'});
  });
  it('never twice for the same change', () => {
    assert.equal(noticeFor({lastSeen: 'BE', current: 'GB', announced: 'geo:BE>GB'}), null);
    // After it showed, the stored country is the new one: nothing more.
    assert.equal(noticeFor({lastSeen: nextLastSeen('BE', 'GB'), current: 'GB', announced: 'geo:BE>GB'}), null);
    // Back again is a new change.
    assert.deepEqual(noticeFor({lastSeen: 'GB', current: 'BE', announced: 'geo:BE>GB'}), {country: 'BE', key: 'geo:GB>BE'});
  });
  it('on the cart, a cart quoting another country shows the cart country, once', () => {
    assert.deepEqual(noticeFor({lastSeen: 'BE', current: 'BE', cartCountry: 'CH', announced: null}), {country: 'CH', key: 'cart:BE>CH'});
    assert.equal(noticeFor({lastSeen: 'BE', current: 'BE', cartCountry: 'CH', announced: 'cart:BE>CH'}), null);
    assert.equal(noticeFor({lastSeen: 'BE', current: 'BE', cartCountry: 'BE', announced: null}), null);
  });
});

describe('noticeText', () => {
  it('names the country and its full line, duties note included', () => {
    assert.equal(noticeText('BE', 'en'), 'Shipping to Belgium: In stock in Belgium, ships in a few working days.');
    assert.equal(
      noticeText('GB', 'en'),
      'Shipping to United Kingdom: Pre-order, ships March 2027. Import VAT and duties: paid by you on delivery, unless collected at checkout.',
    );
    assert.equal(noticeText('JP', 'en'), 'Shipping to Japan: Pre-order, ships March 2027.');
    assert.equal(noticeText('US', 'en'), 'Shipping to United States: Not shipping to the US yet.');
    assert.equal(noticeText('US', 'en', true), 'Shipping to United States: Pre-order, ships March 2027.');
  });
  it('has copy in every locale', () => {
    for (const locale of ['en', 'nl', 'fr'] as const) {
      assert.match(GEO_NOTICE_COPY[locale].line, /\{country\}.*\{line\}/);
      assert.ok(GEO_NOTICE_COPY[locale].dismiss);
      assert.ok(noticeText('DE', locale));
    }
  });
});

describe('the parcel by region (cart "Your parcel", added-to-cart dialog)', () => {
  const batchOne = batchOnePromises(PREORDERS);
  const b1 = [...batchOne][0]!;
  const lines = [
    {shipPromise: b1, deliveryBy: '30 November 2026'},
    {shipPromise: PREORDERS.pendingShips, deliveryBy: '30 April 2027'},
  ];
  it('drops the batch 1 date in a stock region, keeps a funding-target date', () => {
    assert.deepEqual(geoDeliveryLines([lines[0]!], 'eu', batchOne), []);
    assert.deepEqual(geoDeliveryLines(lines, 'eu', batchOne), [lines[1]]);
  });
  it('keeps every date elsewhere, none for the US', () => {
    assert.deepEqual(geoDeliveryLines(lines, 'intl', batchOne), lines);
    assert.deepEqual(geoDeliveryLines(lines, 'import', batchOne), lines);
    assert.deepEqual(geoDeliveryLines(lines, 'fallback', batchOne), lines);
    assert.deepEqual(geoDeliveryLines(lines, 'us', batchOne), []);
  });
  it('a batch 1 line is a pre-order only outside the stock regions', () => {
    assert.equal(geoPreorderLine(b1, 'eu', batchOne), false);
    assert.equal(geoPreorderLine(b1, 'import', batchOne), true);
    assert.equal(geoPreorderLine(b1, 'intl', batchOne), true);
    assert.equal(geoPreorderLine(b1, 'fallback', batchOne), true);
    assert.equal(geoPreorderLine(PREORDERS.pendingShips, 'eu', batchOne), true);
    assert.equal(geoPreorderLine(null, 'intl', batchOne), false);
  });
});

describe('wiring', () => {
  it('PageLayout renders the notice once', () => {
    assert.equal(read('../components/PageLayout.tsx').match(/<LocationNotice \/>/g)?.length, 1);
  });
  it('the notice follows the root geo country and the cart quote country, polite and without SSR text', () => {
    const src = read('../components/LocationNotice.tsx');
    assert.match(src, /geo\?\.country/);
    assert.match(src, /routes\/cart\.\$/);
    assert.match(src, /cartQuoteCountry\(/);
    assert.match(src, /role="status" aria-live="polite"/);
    assert.match(src, /useState<string \| null>\(null\)/);
    assert.match(src, /aria-label=\{GEO_NOTICE_COPY\[locale\]\.dismiss\}/);
    assert.match(src, /'Escape'/);
    // It never takes focus when it opens: the only .focus( calls are in restoreFocus, run on dismiss.
    assert.doesNotMatch(src, /autoFocus/);
    assert.equal(src.match(/\.focus\(/g)?.length, 2);
    assert.match(src, /function restoreFocus\(/);
    assert.match(src, /\[current, cartCountry, locale, usOpen\]/);
  });
  it('dismissing hands focus back (the trigger, else main), never to body; no double announce with the cart alert', () => {
    const src = read('../components/LocationNotice.tsx');
    assert.match(src, /returnTo\.current = active instanceof HTMLElement && active !== document\.body \? active : null;/);
    assert.match(src, /if \(document\.activeElement\?\.closest\('\.location-notice'\)\) restoreFocus\(returnTo\.current\);/);
    assert.match(src, /document\.getElementById\('main-content'\)/);
    assert.match(src, /onClick=\{dismiss\}/);
    // The cart's role=alert notice already speaks the change: the line is shown, not spoken.
    assert.match(src, /querySelector\('\.cart-alert\[role="alert"\]'\)/);
    assert.match(src, /setLive\(!cartAnnounces\(\)\)/);
    assert.match(src, /<p className="sr-only" role="status" aria-live="polite" aria-atomic="true">\s+\{live \? text : null\}/);
    assert.match(src, /aria-hidden=\{live \? true : undefined\}/);
  });
  it('a Ship to change reads the root loader again, so geo.country moves', () => {
    assert.match(read('../components/CountryPicker.tsx'), /await revalidator\.revalidate\(\)/);
    assert.match(read('../root.tsx'), /currentUrl\.toString\(\) === nextUrl\.toString\(\)\) return true/);
  });
  it('the notice is fixed, out of the flow, and lifted above the cart checkout bar', () => {
    const css = read('../styles/site-ui.css');
    assert.match(css, /\.location-notice \{\s*position: fixed;/);
    assert.match(css, /body:has\(\.cart-bar:not\(\.is-hidden\)\) \.location-notice/);
    // Phones: under the header at the top, never over the buy button or the checkout bar.
    const phone = css.match(/@media \(max-width: 640px\) \{\s*\.location-notice \{([^}]*)\}/);
    assert.ok(phone, 'phone rule for .location-notice');
    assert.match(phone[1], /top: calc\(var\(--test-banner-h, 0px\) \+ var\(--avail-bar-h, 0px\) \+ var\(--header-height\)/);
    assert.match(phone[1], /bottom: auto/);
  });
  it('cart and dialog read the parcel date, early bird note and duties note by region', () => {
    for (const file of ['../routes/cart.$.tsx', '../components/CartAddedDialog.tsx']) {
      const src = read(file);
      assert.match(src, /latestDeliveryBy\(\w*(?:\.|\(\)\.)?deliveryLines\(|latestDeliveryBy\(useGeoParcel\(\)\.deliveryLines\(/, file);
      // Early bird prices stay on stock lines (hotfix), and the note's
      // "preorder" wording follows the visitor's pre-order lines.
      assert.match(src, /new Set\(\w*(?:\(\))?\.?preorderSkus\(|new Set\(useGeoParcel\(\)\.preorderSkus\(/, file);
      assert.match(src, /const stockEarly = useAnyEarlySku\([^;]*!preorderSkus\.has\(/, file);
      assert.match(src, /useGeoDutiesNote\(\)/, file);
      assert.doesNotMatch(src, /latestDeliveryBy\((lines|summary\.lines)\)/, file);
    }
  });
  it('the PDP buy box shows the duties note', () => {
    const src = read('../routes/products.$handle.tsx');
    assert.match(src, /useGeoDutiesNote\(\)/);
    assert.match(src, /<p className="product-buy-ship">\{dutiesNote\}<\/p>/);
  });
});

describe('accessibility of the notice and the availability bar (WCAG 2.2 AA)', () => {
  const hex = (css: string, name: string) => css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))?.[1];
  const lum = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string) => {
    const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const tokens = read('../styles/opendrone-tokens.css');
  const app = read('../styles/app.css');
  it('bar text on the gold and notice text on the card reach 4.5:1', () => {
    const gold = hex(tokens, '--od-color-brand-gold')!;
    const onAccent = hex(tokens, '--od-color-neutral-surface-dark')!;
    assert.match(app, /--color-on-accent: var\(--od-color-neutral-surface-dark\)/);
    assert.ok(ratio(onAccent, gold) >= 4.5, `bar ${ratio(onAccent, gold)}`);
    const card = hex(app, '--color-bg-card')!;
    assert.ok(ratio(hex(tokens, '--od-color-neutral-paper')!, card) >= 4.5);
    assert.ok(ratio(hex(app, '--color-text-muted')!, card) >= 4.5);
  });
  it('the bar dismiss fits the 26px strip, so its inset focus ring is not clipped', () => {
    const css = read('../styles/site-ui.css');
    const rule = css.match(/\.avail-bar-close \{[^}]*\}/)![0];
    assert.match(rule, /height: 1\.5rem;/);
    assert.match(css, /\.avail-bar-close:focus-visible \{ outline: 2px solid [^;]+; outline-offset: -2px; \}/);
    assert.match(read('../components/AvailabilityBanner.tsx'), /aria-label=\{words\.dismiss\}/);
  });
  it('the notice wraps within the viewport and has a visible focus ring, no motion', () => {
    const css = read('../styles/site-ui.css');
    assert.match(css, /max-width: min\(24rem, calc\(100vw - 32px\)\)/);
    assert.match(css, /\.location-notice-close:focus-visible \{ outline: 2px solid/);
    const block = css.slice(css.indexOf('.location-notice {'));
    assert.doesNotMatch(block.slice(0, block.indexOf('@media (max-width: 1023px)')), /transition|animation/);
  });
});
