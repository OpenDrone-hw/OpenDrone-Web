import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PRODUCT_CONTENT} from './product-content.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/home-tour.test.ts
//
// The homepage 3D tour (public/models/od3/studio.json) names the boards it
// shows. Those names and the MCU in the note once came from the CAD files
// ("OpenFC-Lite-Mini", "RP2354B") while the shop sold the same board as
// "OpenFC Lite 20×20" with an RP2354A. These tests hold the tour to the
// catalog names and the product specs.

type Beat = {id: string; title: string; note?: string; handle?: string};
type Studio = {beats: Beat[]; boards: Array<{id: string; title: string; note?: string}>};

const studio = JSON.parse(
  readFileSync(new URL('../../public/models/od3/studio.json', import.meta.url), 'utf8'),
) as Studio;

/** The shop's name for a product option: the product family name plus the
 *  option label, the way the listing and the cart print it. */
const SHOP_NAMES: Record<string, string> = {
  'openfc-lite': 'OpenFC Lite',
  openesc: 'OpenESC',
  openrx: 'OpenRX',
  openframe: 'OpenFrame',
};

/** The 3" tour models the 20×20 stack. */
const TOUR_OPTION: Record<string, string> = {
  'openfc-lite': '20×20',
  openesc: '20×20',
};

function specOf(handle: string, option: string, key: string): string | undefined {
  const content = PRODUCT_CONTENT[handle];
  const override = content?.variants?.[option]?.specs?.find(([k]) => k === key);
  if (override) return override[1] ?? undefined;
  return content?.specs?.find(([k]) => k === key)?.[1];
}

describe('home tour copy', () => {
  it('names each board beat the way the shop does', () => {
    for (const beat of studio.beats.filter((b) => b.handle && TOUR_OPTION[b.handle])) {
      const handle = beat.handle!;
      const option = TOUR_OPTION[handle];
      assert.ok(PRODUCT_CONTENT[handle]?.variants?.[option], `${handle} has no ${option} option`);
      assert.equal(beat.title, `${SHOP_NAMES[handle]} ${option}`, `beat ${beat.id}`);
    }
  });

  it('gives the flight controller the MCU of the 20×20 option', () => {
    const fc = studio.beats.find((b) => b.handle === 'openfc-lite');
    assert.ok(fc, 'the tour has a flight controller beat');
    const mcu = specOf('openfc-lite', '20×20', 'MCU');
    assert.ok(mcu, 'the 20×20 option lists an MCU');
    assert.match(fc.note ?? '', new RegExp(`^${mcu} `), 'beat note');
    const board = studio.boards.find((b) => b.title === fc.title);
    assert.ok(board, 'the board entry uses the beat title');
    assert.match(board.note ?? '', new RegExp(`^${mcu} `), 'board note');
  });

  it('keeps CAD part names out of the tour', () => {
    const text = JSON.stringify(studio.beats) + JSON.stringify(studio.boards);
    assert.doesNotMatch(text, /OpenFC-Lite-Mini|OpenESC-20x20/);
  });
});
