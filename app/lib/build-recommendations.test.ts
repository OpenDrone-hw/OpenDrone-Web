import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {buildProfileId, buildSuggestionSpecs} from './build-recommendations.ts';

describe('build recommendation graph', () => {
  it('resolves the build size only from an unambiguous component SKU', () => {
    assert.equal(buildProfileId('OPENFC-LITE-2020'), '3-inch');
    assert.equal(buildProfileId('OPENFRAME-5'), '5-inch');
    assert.equal(buildProfileId('OPENRX-LITE'), null);
  });

  it('specifies four matching motors and a size-appropriate receiver', () => {
    const compact = buildSuggestionSpecs('openfc-lite', 'OPENFC-LITE-2020');
    assert.deepEqual(
      compact.map(({sku, quantity}) => [sku, quantity]),
      [
        ['OPENESC-2020', 1],
        ['OPENFRAME-3', 1],
        ['OPENMOTOR-1604', 4],
        ['OPENRX-LITE', 1],
      ],
    );
    const large = buildSuggestionSpecs('openesc', 'OPENESC-3030');
    assert.ok(large.some(({sku, quantity}) => sku === 'OPENMOTOR-2207' && quantity === 4));
    assert.ok(large.some(({sku}) => sku === 'OPENRX-GEMINI'));
  });

  it('lets Shopify rank compatible products without adding incompatible ones', () => {
    const ranked = buildSuggestionSpecs(
      'openfc-lite',
      'OPENFC-LITE-2020',
      ['openrx', 'openmotor', 'not-a-build-component'],
    );
    assert.deepEqual(ranked.map(({handle}) => handle), [
      'openrx',
      'openmotor',
      'openesc',
      'openframe',
    ]);
    assert.ok(ranked.every(({sku}) => !sku.endsWith('3030') && !sku.endsWith('2207')));
  });
});
