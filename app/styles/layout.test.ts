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
