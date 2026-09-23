import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {buildOf, parseBuilds} from './build-recommendations.ts';

const BUILDS = parseBuilds(
  JSON.parse(fs.readFileSync(new URL('../../content/builds.json', import.meta.url), 'utf8')),
);

describe('build of a SKU', () => {
  it('reads the size from sized parts only', () => {
    assert.equal(buildOf(BUILDS, 'OPENFC-LITE-2020'), '3-inch');
    assert.equal(buildOf(BUILDS, 'OPENFRAME-5'), '5-inch');
    assert.equal(buildOf(BUILDS, 'OPENMOTOR-1604'), '3-inch');
    assert.equal(buildOf(BUILDS, 'OPENRX-GEMINI'), null);
    assert.equal(buildOf(BUILDS, 'OPENRX-MONO'), null);
  });
});

describe('parseBuilds', () => {
  it('rejects a build that uses an unknown role', () => {
    assert.throws(
      () => parseBuilds({roles: {}, builds: [{id: 'x', label: 'x', parts: [{role: 'esc', sku: 'A', quantity: 1}]}]}),
      /unknown role/,
    );
  });
});
