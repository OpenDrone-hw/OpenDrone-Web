import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {parseBuilds} from './build-recommendations.ts';
import {buildForProduct, buildsWithProduct, productRole, relatedParts} from './related-parts.ts';

const BUILDS = parseBuilds(
  JSON.parse(fs.readFileSync(new URL('../../content/builds.json', import.meta.url), 'utf8')),
);

const CATALOG = ['openfc-lite', 'openesc', 'openrx', 'battery-strap', 'elrs-antenna-24'];
const handles = (parts: ReturnType<typeof relatedParts>) => parts.map((p) => p.sku ?? p.handle);

describe('build of a product page', () => {
  it('follows the selected variant', () => {
    assert.equal(buildForProduct(BUILDS, 'openfc-lite', 'OPENFC-LITE-2020'), '3-inch');
    assert.equal(buildForProduct(BUILDS, 'openfc-lite', 'OPENFC-LITE-3030'), '5-inch');
    assert.equal(buildForProduct(BUILDS, 'openframe', 'OPENFRAME-5'), '5-inch');
  });

  it('reads a variant of a build SKU as that build', () => {
    assert.equal(buildForProduct(BUILDS, 'openmotor', 'OPENMOTOR-1604-4S'), '3-inch');
    assert.equal(buildForProduct(BUILDS, 'openmotor', 'OPENMOTOR-2306-4S'), '5-inch');
  });

  it('places a receiver by the build that lists it, else the first build', () => {
    assert.equal(buildForProduct(BUILDS, 'openrx', 'OPENRX-MONO'), '5-inch');
    assert.equal(buildForProduct(BUILDS, 'openrx', 'OPENRX-LITE-UFL'), '3-inch');
    assert.equal(buildForProduct(BUILDS, 'openrx', 'OPENRX-GEMINI'), '3-inch');
  });

  it('lists every build a product fits and none for an accessory', () => {
    assert.deepEqual(buildsWithProduct(BUILDS, 'openesc'), ['3-inch', '5-inch']);
    assert.deepEqual(buildsWithProduct(BUILDS, 'battery-strap'), []);
    assert.equal(buildForProduct(BUILDS, 'battery-strap', 'ACC-STRAP-20X220'), null);
    assert.equal(productRole(BUILDS, 'openmotor'), 'motors');
    assert.equal(productRole(BUILDS, 'battery-strap'), null);
  });
});

describe('related parts', () => {
  it('offers the FC the ESC of its own mount, and the ESC the FC', () => {
    const fc = relatedParts(BUILDS, {handle: 'openfc-lite', sku: 'OPENFC-LITE-2020'}, CATALOG);
    assert.deepEqual(fc[0], {handle: 'openesc', sku: 'OPENESC-2020', quantity: 1});
    assert.ok(!fc.some((p) => p.sku === 'OPENESC-3030'));
    const esc = relatedParts(BUILDS, {handle: 'openesc', sku: 'OPENESC-3030'}, CATALOG);
    assert.deepEqual(esc[0], {handle: 'openfc-lite', sku: 'OPENFC-LITE-3030', quantity: 1});
  });

  it('offers the frame four motors and the stack of its size', () => {
    const frame = relatedParts(BUILDS, {handle: 'openframe', sku: 'OPENFRAME-3'}, CATALOG);
    assert.deepEqual(frame.slice(0, 3), [
      {handle: 'openmotor', sku: 'OPENMOTOR-1604-4S', quantity: 4},
      {handle: 'openfc-lite', sku: 'OPENFC-LITE-2020', quantity: 1},
      {handle: 'openesc', sku: 'OPENESC-2020', quantity: 1},
    ]);
  });

  it('offers the motor its frame and props', () => {
    const motor = relatedParts(BUILDS, {handle: 'openmotor', sku: 'OPENMOTOR-2306-4S'}, CATALOG);
    assert.deepEqual(handles(motor).slice(0, 2), ['OPENFRAME-5', 'ACC-PROP-5-HQ-5X43X3-V2S']);
  });

  it('offers the receiver its antenna', () => {
    const mono = relatedParts(BUILDS, {handle: 'openrx', sku: 'OPENRX-MONO'}, CATALOG);
    assert.equal(mono[0].sku, 'ACC-ANT-DUAL-T');
    const ufl = relatedParts(BUILDS, {handle: 'openrx', sku: 'OPENRX-LITE-UFL'}, CATALOG);
    assert.equal(ufl[0].sku, 'ACC-ANT-T');
    // A receiver no extra names still gets the antenna product.
    const lite = relatedParts(BUILDS, {handle: 'openrx', sku: 'OPENRX-LITE'}, CATALOG);
    assert.deepEqual(lite[0], {handle: 'elrs-antenna-24', sku: null, quantity: 1});
  });

  it('keeps accessories after the complementary parts, once each, never the page itself', () => {
    const fc = relatedParts(BUILDS, {handle: 'openfc-lite', sku: 'OPENFC-LITE-2020'}, CATALOG);
    assert.deepEqual(handles(fc), [
      'OPENESC-2020',
      'ACC-STRAP-15X200',
      'openrx',
      'battery-strap',
      'elrs-antenna-24',
    ]);
    const ufl = relatedParts(BUILDS, {handle: 'openrx', sku: 'OPENRX-LITE-UFL'}, CATALOG);
    assert.equal(ufl.filter((p) => p.handle === 'elrs-antenna-24').length, 1);
    assert.ok(!ufl.some((p) => p.handle === 'openrx'));
  });

  it('falls back to the catalog for an accessory', () => {
    assert.deepEqual(
      handles(relatedParts(BUILDS, {handle: 'battery-strap', sku: 'ACC-STRAP-20X220'}, CATALOG)),
      ['openfc-lite', 'openesc', 'openrx', 'elrs-antenna-24'],
    );
  });
});
