import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {picksForStep, resolveHeroBuilds, type HeroBuildsConfig} from './hero-build.ts';
import type {ProductCardFragment, ProductVariantFragment} from './product-shapes.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/hero-build.test.ts
//
// The homepage walkthrough doubles as the build guide: each part step shows
// the build's pick for that part, the last step the whole build with one add.

const builds = JSON.parse(
  readFileSync(new URL('../../content/builds.json', import.meta.url), 'utf8'),
) as HeroBuildsConfig;

function variant(sku: string, title: string, amount: string, available = true): ProductVariantFragment {
  return {
    id: sku,
    sku,
    title,
    availableForSale: available,
    price: {amount, currencyCode: 'EUR'},
    compareAtPrice: null,
    image: null,
    product: {title: '', handle: ''},
    selectedOptions: title === 'Default Title' ? [{name: 'Title', value: title}] : [{name: 'Model', value: title}],
    cartAddUrl: '',
    shipPromise: 'ships late October 2026',
    campaign: null,
    priceAfter: null,
    availability: 'preorder',
    shopUrl: null,
  };
}

function product(handle: string, title: string, variants: ProductVariantFragment[]): ProductCardFragment {
  return {
    id: handle,
    handle,
    title,
    productType: null,
    featuredImage: null,
    priceRange: {minVariantPrice: variants[0].price, maxVariantPrice: variants[0].price},
    variants: {nodes: variants},
  };
}

const catalog = [
  product('openfc-lite', 'OpenFC Lite', [variant('OPENFC-LITE-2020', '20x20', '23.20'), variant('OPENFC-LITE-3030', '30x30', '31.20')]),
  product('openesc', 'OpenESC', [variant('OPENESC-2020', '20x20', '39.20'), variant('OPENESC-3030', '30x30', '47.20')]),
  product('openframe', 'OpenFrame', [variant('OPENFRAME-3', '3"', '31.20'), variant('OPENFRAME-5', '5"', '39.20')]),
  product('openmotor', 'OpenMotor', [variant('OPENMOTOR-1604', '1604', '15.20'), variant('OPENMOTOR-2207', '2207', '19.20')]),
  product('openrx', 'OpenRX', [variant('OPENRX-LITE', 'Lite', '16.80'), variant('OPENRX-LITE-UFL', 'Lite-UFL', '16.80')]),
];
const opts = {
  sellable: () => true,
  nameOf: (_h: string, title: string, v: string) => (v === 'Default Title' ? title : `${title} ${v}`),
};

describe('hero build', () => {
  const [three, five] = resolveHeroBuilds(builds, catalog, opts);

  it('resolves both builds from content/builds.json', () => {
    assert.equal(three.id, '3-inch');
    assert.equal(five.id, '5-inch');
    assert.deepEqual(
      three.parts.map((p) => p.sku),
      ['OPENFC-LITE-2020', 'OPENESC-2020', 'OPENFRAME-3', 'OPENMOTOR-1604', 'OPENRX-LITE'],
    );
  });

  it('prices a set part per quad and totals the build', () => {
    const motors = three.parts.find((p) => p.role === 'motors')!;
    assert.equal(motors.quantity, 4);
    assert.equal(three.total.toFixed(2), (23.2 + 39.2 + 31.2 + 4 * 15.2 + 16.8).toFixed(2));
  });

  it('adds the whole build in one cart call with set quantities', () => {
    assert.match(three.addHref ?? '', /lines=OPENFC-LITE-2020%3A1%2COPENESC-2020%3A1%2COPENFRAME-3%3A1%2COPENMOTOR-1604%3A4%2COPENRX-LITE%3A1/);
    assert.match(three.parts[3].addHref, /sku=OPENMOTOR-1604&qty=4/);
  });

  it('links each pick to its variant', () => {
    assert.equal(five.parts[0].url, '/products/openfc-lite?Model=30x30');
  });

  it('leaves out of the build add what cannot be bought', () => {
    const [soldOut] = resolveHeroBuilds(builds, catalog, {...opts, sellable: (h) => h !== 'openrx'});
    const rx = soldOut.parts.find((p) => p.role === 'receiver')!;
    assert.equal(rx.buyable, false);
    assert.doesNotMatch(soldOut.addHref ?? '', /OPENRX/);
  });

  it('shows a part and its accessories on the part step', () => {
    const withProps: HeroBuildsConfig = {
      roles: {...builds.roles, motors: {handle: 'openmotor'}, props: {}},
      builds: [
        {
          id: '3-inch',
          label: '3-inch',
          parts: [
            {role: 'motors', sku: 'OPENMOTOR-1604', quantity: 4},
            {role: 'props', sku: 'ACC-PROP-3', quantity: 1, handle: 'props-3'},
          ],
        },
      ],
    };
    const [b] = resolveHeroBuilds(
      withProps,
      [...catalog, product('props-3', 'Props 3"', [variant('ACC-PROP-3', 'Default Title', '4.00')])],
      opts,
    );
    assert.deepEqual(picksForStep(b, 'openmotor').map((p) => p.sku), ['OPENMOTOR-1604', 'ACC-PROP-3']);
    assert.equal(b.parts[1].url, '/products/props-3');
    assert.deepEqual(picksForStep(b, undefined), []);
  });

  it('skips a part the catalog does not carry', () => {
    const [b] = resolveHeroBuilds(builds, catalog.filter((p) => p.handle !== 'openrx'), opts);
    assert.equal(b.parts.some((p) => p.role === 'receiver'), false);
  });
});
