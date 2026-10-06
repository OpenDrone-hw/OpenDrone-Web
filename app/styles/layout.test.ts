/**
 * Layout guards that a unit test can hold without a browser: rules whose
 * removal once pushed pages wider than a 390 px phone.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const CSS = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

/** Every declaration block whose selector list names `selector`. */
function blocksFor(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(CSS); m; m = re.exec(CSS)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

describe('buy module price notes', () => {
  it('never forces the price notes onto one line', () => {
    for (const selector of ['.product-buy-vat', '.product-buy-unit', '.product-buy-amount']) {
      const blocks = blocksFor(selector);
      assert.ok(blocks.length > 0, `${selector} has no rules`);
      for (const block of blocks) {
        assert.doesNotMatch(block, /white-space:\s*nowrap/, `${selector} must wrap`);
      }
    }
  });

  it('lets the price row wrap', () => {
    assert.ok(
      blocksFor('.product-buy-amount').some((b) => /flex-wrap:\s*wrap/.test(b)),
      '.product-buy-amount needs flex-wrap: wrap',
    );
  });
});

describe('legal tables', () => {
  it('scroll inside their own box', () => {
    assert.ok(
      blocksFor('.legal-body .table-scroll').some((b) => /overflow-x:\s*auto/.test(b)),
      '.legal-body .table-scroll (focusable wrapper around each table) needs overflow-x: auto',
    );
  });
});

describe('mobile homepage build card', () => {
  it('lets a vertical swipe on the parts list scroll the page', () => {
    const UI = readFileSync(new URL('./site-ui.css', import.meta.url), 'utf8');
    const mobile = UI.match(/@media \(max-width: 768px\) \{[^@]*?\.home-mobile-build \.hero-build-parts \{([^}]*)\}/);
    assert.ok(mobile, 'phone rule for .home-mobile-build .hero-build-parts is missing');
    assert.match(mobile[1], /overflow:\s*visible/, 'the phone parts list must not be a scroll container');
    assert.match(mobile[1], /overscroll-behavior:\s*auto/, 'contain blocks scroll chaining on Chrome Android');
  });
});

describe('PDP chapters never shift the page', () => {
  it('chapters do not skip-render with a placeholder size (content-visibility: auto shifted the related strip and footer)', () => {
    const blocks = blocksFor('.chapter');
    assert.ok(blocks.length > 0, '.chapter has rules');
    const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of blocks) {
      assert.doesNotMatch(noComments(block), /content-visibility:\s*auto/);
      assert.doesNotMatch(noComments(block), /contain-intrinsic-size/);
    }
    assert.doesNotMatch(noComments(CSS), /\.chapter[^{,]*\{[^}]*content-visibility:\s*auto/);
  });
});

describe('order cards and the pinned buy bar keep clear of other content', () => {
  const UI = readFileSync(new URL('./site-ui.css', import.meta.url), 'utf8');

  it('pins the desktop buy bar below the header, under the availability and test bars', () => {
    const desktop = CSS.match(/@media \(min-width: 960px\) \{\s*\.buy-rail\.is-pinned \{([^}]*)\}/);
    assert.ok(desktop, 'desktop rule for .buy-rail.is-pinned is missing');
    const top = desktop[1].replace(/\/\*[\s\S]*?\*\//g, '').match(/top:\s*([^;]+);/);
    assert.ok(top, 'the pinned bar needs a top');
    for (const part of ['--avail-bar-h', '--test-banner-h', '--header-height']) {
      assert.ok(top[1].includes(part), `the pinned bar's top must add ${part}`);
    }
  });

  it('gives the product page build card no section padding', () => {
    assert.ok(
      blocksFor('.pdp-build .hero-build-guide').some((b) => /padding:\s*0;/.test(b)),
      '.pdp-build .hero-build-guide needs padding: 0',
    );
  });

  it('hides the hero beat copy where the stack offer makes the card column cover it', () => {
    const rule = UI.match(/@media \(max-height: (\d+)px\) and \(min-width: 769px\) \{\s*\.homepage:has\(\.hero-stack-offer\) \.hp-copy \{ display: none; \}/);
    assert.ok(rule, 'the stack offer rule for .hp-copy is missing');
    // Card column 725 px + 36 px bottom offset + the copy down to 264 px + 12 px clear.
    assert.ok(Number(rule[1]) >= 1037, 'the copy must be hidden on every height where the cards reach it');
  });
});

describe('buy now or pre-order blocks', () => {
  const UI = readFileSync(new URL('./site-ui.css', import.meta.url), 'utf8');
  const plain = UI.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (selector: string): string => {
    const at = plain.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `${selector} has no rule`);
    return plain.slice(at, plain.indexOf('}', at));
  };

  it('puts the two offer cards side by side and stacks them on a phone', () => {
    assert.match(rule('.offer-choice'), /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(plain, /@media \(max-width: 480px\) \{\s*\.offer-choice \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  it('lets a card shrink inside a 390 px phone and keeps its radio focusable', () => {
    for (const selector of ['.offer-choice', '.offer-card', '.hero-choice', '.hero-choice-option']) {
      assert.match(rule(selector), /min-width:\s*0/, `${selector} must be allowed to shrink`);
    }
    // Hidden by opacity, never display: none, so keyboard and screen readers reach it.
    assert.match(rule('.offer-card-input'), /opacity:\s*0/);
    assert.doesNotMatch(rule('.offer-card-input'), /display:\s*none|visibility:\s*hidden/);
    assert.match(plain, /\.offer-card:has\(\.offer-card-input:focus-visible\) \{[^}]*outline:/);
    assert.match(plain, /\.hero-choice-option:has\(input:focus-visible\) \{[^}]*outline:/);
  });

  it('never cuts a part name in the home build block', () => {
    const name = rule('.hero-build-choice .hero-build-name strong');
    assert.match(name, /white-space:\s*normal/);
    assert.match(name, /text-overflow:\s*clip/);
  });

  it('drops the 3D hero highlight where there is no 3D hero beside the list', () => {
    assert.match(plain, /@media \(max-width: 1023px\) \{\s*\.hero-build-choice \.hero-build-part\.is-active \{ background: none; \}/);
    assert.match(plain, /\.home-mobile-build \.hero-build-choice \.hero-build-part\.is-active,\s*\.pdp-build \.hero-build-choice \.hero-build-part\.is-active \{ background: none; \}/);
  });

  it('the cart says the pre-order lane once, with no per-line badges or mixed-order actions', () => {
    assert.ok(rule('.cart-together'));
    assert.doesNotMatch(plain, /\.cart-line-badge|\.cart-choice-action/);
  });

  it('keeps the pinned bar one slim row: the switch, never the cards', () => {
    assert.match(plain, /\.buy-rail\.is-pinned \.offer-card-line,\s*\.buy-rail\.is-pinned \.offer-card-title,\s*\.buy-rail\.is-pinned \.offer-card-price,\s*\.buy-rail\.is-pinned \.offer-addon,\s*\.buy-rail\.is-pinned \.offer-slot,\s*\.buy-rail\.is-pinned \.buy-total,\s*\.buy-rail\.is-pinned \.product-buy:has\(> \.offer-choice\) \.product-buy-price \{ display: none; \}/);
    // The segments: "Buy now 29.00", "Pre-order 26.10", the price shown even when both cost the same.
    assert.match(plain, /\.buy-rail\.is-pinned \.offer-card-pin,\s*\.buy-rail\.is-pinned \.offer-card-pinprice \{ display: inline;/);
    // A phone: name over price, so "Buy the stack now" still fits the row.
    assert.match(plain, /@media \(max-width: 480px\) \{[^}]*\.buy-rail\.is-pinned \.offer-card-head \{ flex-direction: column;/);
    assert.match(rule('.buy-rail.is-pinned .offer-choice'), /height:\s*var\(--pin-h, 36px\)/);
    // One button width for both labels.
    assert.match(plain, /\.buy-rail\.is-pinned \.product-buy:has\(> \.offer-choice\) \.product-form \.btn-primary \{ min-width:/);
  });

  it('moves nothing when the mode changes: one status slot, one price column, tabular digits', () => {
    assert.match(rule('.offer-status'), /min-height:/);
    assert.match(rule('.offer-status'), /white-space:\s*nowrap/);
    assert.match(rule('.hero-build-choice .hero-build-price'), /min-width:\s*\d+px/);
    assert.match(rule('.hero-build-choice .hero-build-price'), /tabular-nums/);
    assert.match(rule('.offer-card-title,\n.offer-card-price'), /tabular-nums/);
  });

  it('sets the offer cards on the size tile scale and selection style', () => {
    const title = rule('.offer-card-title,\n.offer-card-price');
    assert.match(title, /font-size:\s*var\(--fs-sm\)/);
    assert.match(rule('.offer-card-line'), /font-size:\s*var\(--fs-xs\)/);
    assert.match(rule('.offer-card'), /padding:\s*var\(--sp-3\)/);
    assert.match(rule('.offer-choice'), /gap:\s*var\(--sp-2\)/);
    assert.match(rule('.offer-card.is-selected'), /box-shadow:\s*0 0 0 1\.75px var\(--color-gold\)/);
  });

  it('reserves the stack add-on row and the stack total slot, so choosing or ticking moves nothing', () => {
    assert.match(rule('.offer-addon'), /min-height:/);
    assert.match(rule('.offer-addon-text'), /white-space:\s*nowrap/);
    assert.match(rule('.product-buy .product-form > .buy-total,\n.product-buy .product-form:has(> .product-qty) > .product-qty ~ .buy-total'), /flex:\s*0 0 4\.75rem/);
    assert.doesNotMatch(plain, /\.offer-single|\.offer-choice-foot|\.cta-short|\.offer-addon-build(?![-\w])|\.offer-addon-more/);
  });

  it('one offer is a status row on the card scale; a page with two offers keeps the cards height for it', () => {
    assert.match(rule('.offer-status-row'), /font-size:\s*var\(--fs-xs\)/);
    assert.match(rule('.offer-status-row-title'), /font-size:\s*var\(--fs-sm\)/);
    assert.match(rule('.offer-slot > *'), /grid-area:\s*1 \/ 1/);
    assert.match(rule('.offer-slot-ghost'), /visibility:\s*hidden/);
  });

  it('hides the hero beat copy on every height where the pre-order block reaches it', () => {
    const hide = plain.match(/@media \(max-height: (\d+)px\) and \(min-width: 769px\) \{\s*\.homepage:has\(\.hero-build-choice\) \.hp-copy \{ display: none; \}/);
    assert.ok(hide, 'the rule for .hp-copy beside the build block is missing');
    // Block up to 590 px + 36 px bottom offset + the copy down to 264 px + 12 px clear.
    assert.ok(Number(hide[1]) >= 902);
    const list = plain.match(/\.hero-buy--guide \.hero-build-choice \.hero-build-parts \{ max-height: min\((\d+)px, calc\(100svh - (\d+)px\)\); \}/);
    assert.ok(list, 'the block needs its own list height');
    // On the shortest guarded laptop (768 px) the block must end above the header's 180 px zone.
    assert.ok(768 - 36 - (768 - Number(list[2]) + 200) >= 180);
  });
});

describe('specs backdrop performance contract', () => {
  const UI = readFileSync(new URL('./site-ui.css', import.meta.url), 'utf8');
  const TSX = readFileSync(
    new URL('../components/ProductSilhouette.tsx', import.meta.url),
    'utf8',
  );

  it('renders the board backdrop as a single static <img>', () => {
    assert.match(
      TSX,
      /className="product-silhouette-img"/,
      'the board backdrop must be one <img>',
    );
    assert.doesNotMatch(
      TSX,
      /product-silhouette-light--/,
      'the board backdrop must not carry animated light layers',
    );
  });

  it('keeps that <img> flat and unmasked', () => {
    const img = UI.match(/\.product-silhouette-img\s*\{([^}]*)\}/);
    assert.ok(img, '.product-silhouette-img rule is missing');
    assert.match(img[1], /opacity:/, 'the backdrop <img> needs a flat opacity');
    assert.doesNotMatch(
      img[1],
      /mask-image:/,
      'the backdrop <img> must not be masked (re-composite cost)',
    );
  });
});
