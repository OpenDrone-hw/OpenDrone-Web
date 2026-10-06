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
      blocksFor('.legal-body table').some((b) => /overflow-x:\s*auto/.test(b)),
      '.legal-body table needs overflow-x: auto',
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
