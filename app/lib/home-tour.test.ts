import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PRODUCT_CONTENT} from './product-content.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/home-tour.test.ts
//
// The homepage 3D tour (public/models/od3/studio.json) labels the parts it
// shows: "OpenFC Lite" then its spec note. These tests hold the labels to the
// catalog names and the product specs.

type Beat = {id: string; title: string; note?: string; handle?: string};
type Studio = {beats: Beat[]; boards: Array<{id: string; title: string; note?: string}>};

const studio = JSON.parse(
  readFileSync(new URL('../../public/models/od3/studio.json', import.meta.url), 'utf8'),
) as Studio;

/** The shop's name for each product, the way the listing prints it. */
const SHOP_NAMES: Record<string, string> = {
  'openfc-lite': 'OpenFC Lite',
  openesc: 'OpenESC',
  openrx: 'OpenRX',
  openframe: 'OpenFrame',
};

function specOf(handle: string, option: string, key: string): string | undefined {
  const content = PRODUCT_CONTENT[handle];
  const override = content?.variants?.[option]?.specs?.find(([k]) => k === key);
  if (override) return override[1] ?? undefined;
  return content?.specs?.find(([k]) => k === key)?.[1];
}

describe('home tour copy', () => {
  it('names each product beat the way the shop does', () => {
    for (const beat of studio.beats.filter((b) => b.handle)) {
      assert.equal(beat.title, SHOP_NAMES[beat.handle!], `beat ${beat.id}`);
    }
  });

  it('gives the flight controller the input range of the 20×20 option', () => {
    const fc = studio.beats.find((b) => b.handle === 'openfc-lite');
    assert.ok(fc, 'the tour has a flight controller beat');
    const input = specOf('openfc-lite', '20×20', 'Input');
    const cells = /^(\d)\D(\d)S\b/.exec(input ?? '');
    assert.ok(cells, 'the 20×20 option lists an input in cells');
    assert.match(fc.note ?? '', new RegExp(`\\b${cells[1]}-${cells[2]}S\\b`), 'beat note');
  });

  it('keeps CAD part names out of the tour', () => {
    const text = JSON.stringify(studio.beats) + JSON.stringify(studio.boards);
    assert.doesNotMatch(text, /OpenFC-Lite-Mini|OpenESC-20x20/);
  });
});
