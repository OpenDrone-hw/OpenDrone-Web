import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageTier} from './gallery-tier.ts';

const frames = {'5" Freestyle': ['5', '5"', '5in', '5-inch'], '3" Freestyle': ['3', '3"', '3in', '3-inch']};
const cdn = 'https://cdn.shopify.com/s/files/1/1032/6641/9033/files/';

test('frame images split by size, upload hashes ignored', () => {
  assert.equal(imageTier(cdn + 'openframe-5-main_a37ee04e-3c83-4652-bcaa-7b01653d0e38.png?v=1', null, frames), '5" Freestyle');
  assert.equal(imageTier(cdn + 'openframe-3-main_fa1ab8f7-4cc8-477d-a72c-ac899f789228.png', null, frames), '3" Freestyle');
  assert.equal(imageTier(cdn + 'openframe-3-top.png', null, frames), '3" Freestyle');
  assert.equal(imageTier(cdn + 'openframe-5-top.png', null, frames), '5" Freestyle');
});

test('images naming no tier stay on every tier', () => {
  assert.equal(imageTier(cdn + 'openframe-video-xray.jpg', null, frames), null);
  assert.equal(imageTier(cdn + 'DSC08242.jpg', 'Frame on the bench', frames), null);
});

test('alt text names a tier', () => {
  assert.equal(imageTier(cdn + 'IMG_1234.jpg', 'OpenFrame 5-inch, top', frames), '5" Freestyle');
});

test('longest name wins for nested tier names', () => {
  const rx = {'Lite': ['lite'], 'Lite-UFL': ['lite-ufl']};
  assert.equal(imageTier(cdn + 'openrx-lite-ufl-top.png', null, rx), 'Lite-UFL');
  assert.equal(imageTier(cdn + 'openrx-lite-top.png', null, rx), 'Lite');
  const esc = {'20x20': [], '30x30': []};
  assert.equal(imageTier(cdn + 'openesc-20x20-back.png', null, esc), '20x20');
});
