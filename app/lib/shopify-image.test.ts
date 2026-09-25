import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {shopifyImageUrl, shopifySrcSet, srcsetPick} from './shopify-image.ts';

const CDN = 'https://cdn.shopify.com/s/files/1/0001/files/DSC08242.jpg?v=17';

describe('shopify images', () => {
  it('resizes and converts CDN images, keeping the version', () => {
    const u = new URL(shopifyImageUrl(CDN, 320));
    assert.equal(u.searchParams.get('width'), '320');
    assert.equal(u.searchParams.get('format'), 'webp');
    assert.equal(u.searchParams.get('v'), '17');
  });

  it('leaves other URLs alone', () => {
    assert.equal(shopifyImageUrl('/boards/openfc.webp', 320), '/boards/openfc.webp');
    assert.equal(shopifySrcSet('/boards/openfc.webp'), undefined);
  });

  it('caps the srcset at the slot width', () => {
    const set = shopifySrcSet(CDN, 160)!;
    assert.deepEqual(set.split(', ').map((s) => s.split(' ')[1]), ['160w']);
    assert.ok(shopifySrcSet(CDN)!.endsWith('1600w'));
  });

  it('picks the width a browser would take from the srcset', () => {
    assert.equal(srcsetPick(350, 2.6, 1080), 960);
    assert.equal(srcsetPick(600, 2, 1080), 1080);
    assert.equal(srcsetPick(187, 2.6, 800), 640);
  });
});
