import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {parseBuilds, partHandle} from './build-recommendations.ts';
import {bySku, type Catalog} from './catalog.ts';
import {
  heroBuildSelection,
  resolveHeroBuilds,
  type HeroBuild,
} from './hero-build.ts';
import {requestedLines} from './shopify-cart-input.ts';

const config = parseBuilds(
  JSON.parse(
    fs.readFileSync(
      new URL('../../content/builds.json', import.meta.url),
      'utf8',
    ),
  ),
);

function catalog(): Catalog {
  const result: Catalog = {
    schema: 1,
    generated_at: '',
    max_age: 60,
    currency: 'EUR',
    prices_include_vat: true,
    shop_url: 'https://shop.example',
    cart_url: '/cart',
    add_url: '/api/shopify/cart',
    products: [],
  };
  for (const build of config.builds)
    for (const part of build.parts) {
      const handle = partHandle(config, part);
      let product = result.products.find((item) => item.handle === handle);
      if (!product) {
        product = {
          handle,
          title: handle,
          family: null,
          description: null,
          url: `/products/${handle}`,
          images: [],
          rating: null,
          variants: [],
        };
        result.products.push(product);
      }
      product.variants.push({
        sku: part.sku,
        title: part.sku,
        model: null,
        options: {Size: build.id},
        price: part.role === 'motors' ? 19.2 : 10.1,
        compare_price: null,
        currency: 'EUR',
        availability: 'preorder',
        ship_promise: null,
        image: null,
        url: product.url,
        cart_add_url: result.add_url,
      });
    }
  return result;
}

const all = (build: HeroBuild) => new Set(build.parts.map((part) => part.sku));
const sellable = () => true;

describe('hero build shopping guide', () => {
  it('selects matching frame, stack and receiver SKUs for each size', () => {
    const builds = resolveHeroBuilds(config, catalog());
    const three = builds.find((build) => build.size === '3')!;
    const five = builds.find((build) => build.size === '5')!;
    assert.deepEqual(
      three.parts.slice(0, 5).map((part) => [part.sku, part.quantity]),
      [
        ['OPENFC-LITE-2020', 1],
        ['OPENESC-2020', 1],
        ['OPENFRAME-3', 1],
        ['OPENMOTOR-1604', 4],
        ['OPENRX-LITE-UFL', 1],
      ],
    );
    assert.deepEqual(
      five.parts.slice(0, 5).map((part) => [part.sku, part.quantity]),
      [
        ['OPENFC-LITE-3030', 1],
        ['OPENESC-3030', 1],
        ['OPENFRAME-5', 1],
        ['OPENMOTOR-2207', 4],
        ['OPENRX-MONO', 1],
      ],
    );
    assert.equal(
      three.parts.find((part) => part.role === 'props')?.sku,
      'ACC-PROP-3-HQ-T3X3X3',
    );
    assert.equal(
      three.parts.some((part) => part.role === 'antenna'),
      true,
    );
    assert.equal(
      five.parts.find((part) => part.role === 'antenna')?.sku,
      'ACC-ANT-DUAL-T',
    );
    assert.match(five.parts[2].url, /Size=5-inch/);
  });

  it('submits all build lines through the existing cart input with four motors and an exact total', () => {
    const five = resolveHeroBuilds(config, catalog()).find(
      (build) => build.size === '5',
    )!;
    const selection = heroBuildSelection(five, all(five), sellable);
    const form = new FormData();
    new URL(selection.href, 'https://example.com').searchParams.forEach(
      (value, key) => form.append(key, value),
    );
    assert.deepEqual(requestedLines(form), [
      {sku: 'OPENFC-LITE-3030', quantity: 1},
      {sku: 'OPENESC-3030', quantity: 1},
      {sku: 'OPENFRAME-5', quantity: 1},
      {sku: 'OPENMOTOR-2207', quantity: 4},
      {sku: 'OPENRX-MONO', quantity: 1},
      {sku: 'ACC-PROP-5-HQ-5X43X3-V2S', quantity: 1},
      {sku: 'ACC-ANT-DUAL-T', quantity: 1},
    ]);
    assert.equal(selection.total, 137.4);
    assert.equal(selection.available, true);
    assert.equal(selection.complete, true);
  });

  it('keeps a missing receiver visible and blocks a complete build instead of substituting another receiver', () => {
    const source = catalog();
    const receiver = bySku(source, 'OPENRX-MONO')!.product;
    receiver.variants = receiver.variants.filter(
      (variant) => variant.sku !== 'OPENRX-MONO',
    );
    const build = resolveHeroBuilds(config, source).find(
      (item) => item.size === '5',
    )!;
    assert.equal(build.parts.length, 7);
    assert.equal(
      build.parts.find((part) => part.role === 'receiver')?.available,
      false,
    );
    const selection = heroBuildSelection(build, all(build), sellable);
    assert.equal(selection.available, false);
    assert.equal(selection.total, null);
  });

  it('honors sold-out variants and product status, allowing a subset only after explicit deselection', () => {
    const source = catalog();
    bySku(source, 'OPENFRAME-5')!.variant.availability = 'sold_out';
    const build = resolveHeroBuilds(config, source).find(
      (item) => item.size === '5',
    )!;
    const included = all(build);
    const allowed = (handle: string) => handle !== 'openmotor';
    assert.equal(heroBuildSelection(build, included, allowed).available, false);
    included.delete('OPENFRAME-5');
    assert.equal(heroBuildSelection(build, included, allowed).available, false);
    included.delete('OPENMOTOR-2207');
    const selection = heroBuildSelection(build, included, allowed);
    assert.equal(selection.available, true);
    assert.equal(selection.complete, false);
    assert.equal(selection.total, 50.5);
    assert.doesNotMatch(selection.href, /OPENFRAME|OPENMOTOR/);
  });

  it('does not offer an empty or mixed-currency selection', () => {
    const build = resolveHeroBuilds(config, catalog())[0];
    assert.equal(
      heroBuildSelection(build, new Set(), sellable).available,
      false,
    );
    build.parts[0].currency = 'USD';
    const selection = heroBuildSelection(build, all(build), sellable);
    assert.equal(selection.available, false);
    assert.equal(selection.total, null);
  });
});
