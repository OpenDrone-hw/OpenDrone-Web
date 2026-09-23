import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {PRODUCT_CONTENT} from './product-content.ts';
import {stepCounter, tourSteps} from './home-tour.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/home-tour.test.ts
//
// The homepage walkthrough (public/models/od3/studio.json) explains the drone
// one part per step: the part's role, one or two sentences on what it does,
// and the product line when the shop sells it. These tests hold the words to
// the house style and the claims to the product content.

type Stop = {id?: string; at: number; park?: number; title: string; caption?: string; handle?: string};
type Beat = {id: string; title: string; caption?: string; handle?: string; stops?: Stop[]};
type Studio = {beats: Beat[]; boards: Array<{id: string; title: string; note?: string}>};

const studio = JSON.parse(
  readFileSync(new URL('../../public/models/od3/studio.json', import.meta.url), 'utf8'),
) as Studio;
const steps = tourSteps(studio.beats);

function specOf(handle: string, option: string, key: string): string | undefined {
  const content = PRODUCT_CONTENT[handle];
  const override = content?.variants?.[option]?.specs?.find(([k]) => k === key);
  if (override) return override[1] ?? undefined;
  const highlight = content?.variants?.[option]?.highlights?.find(([k]) => k === key);
  if (highlight) return highlight[1] ?? undefined;
  return content?.specs?.find(([k]) => k === key)?.[1];
}

describe('home tour steps', () => {
  it('flattens a beat with stops into one step per stop', () => {
    const frame = studio.beats.find((b) => b.stops?.length);
    assert.ok(frame, 'the airframe beat has stops');
    const ids = steps.map((s) => s.id);
    for (const st of frame.stops!) assert.ok(ids.includes(st.id!), `step ${st.id}`);
    const expected = studio.beats.reduce((n, b) => n + Math.max(1, b.stops?.length ?? 0), 0);
    assert.equal(steps.length, expected);
  });

  it('gives every step a unique id, a role and a caption', () => {
    assert.equal(new Set(steps.map((s) => s.id)).size, steps.length);
    for (const s of steps) {
      assert.ok(s.title.trim(), `step ${s.id} has a title`);
      assert.ok(s.caption?.trim(), `step ${s.id} has a caption`);
    }
  });

  it('counts steps as "02 / 07"', () => {
    assert.equal(stepCounter(1, 7), '02 / 07');
    assert.equal(stepCounter(9, 12), '10 / 12');
  });

  it('keeps a stop park inside its own caption window', () => {
    for (const b of studio.beats) {
      b.stops?.forEach((st, j) => {
        const next = b.stops![j + 1]?.at ?? 1;
        if (st.park !== undefined)
          assert.ok(st.park > st.at && st.park < next, `${b.id} stop ${j}: park ${st.park}`);
      });
    }
  });
});

describe('home tour copy', () => {
  it('keeps each caption to 25 words in the house style', () => {
    for (const s of steps) {
      const text = `${s.title} ${s.caption ?? ''}`;
      const words = (s.caption ?? '').split(/\s+/).filter(Boolean).length;
      assert.ok(words <= 25, `${s.id}: ${words} words`);
      assert.doesNotMatch(text, /\u2014/, `${s.id}: em dash`);
      assert.doesNotMatch(text, /\?/, `${s.id}: question`);
      assert.doesNotMatch(text, /\b(we|our|us)\b/i, `${s.id}: "we"`);
    }
  });

  it('links only products the shop has content for', () => {
    for (const s of steps.filter((st) => st.handle))
      assert.ok(PRODUCT_CONTENT[s.handle!], `${s.id}: unknown product ${s.handle}`);
  });

  it('shows no product line for the video system, which is not sold here', () => {
    const camera = steps.find((s) => /camera|vtx/i.test(s.title));
    assert.ok(camera, 'the tour has a camera + VTX step');
    assert.equal(camera.handle, undefined);
  });

  it('names only video systems the frame has a camera mount for', () => {
    const camera = steps.find((s) => /camera|vtx/i.test(s.title));
    const mounts = PRODUCT_CONTENT.openframe?.specs?.find(([k]) => k === 'Cam mounts')?.[1] ?? '';
    for (const system of ['DJI', 'Walksnail', 'HDZero', 'analog'])
      if (camera?.caption?.includes(system))
        assert.match(mounts, new RegExp(system, 'i'), `${system} is not in the frame's camera mounts`);
  });

  it('gives the receiver a band every OpenRX option has', () => {
    const rx = steps.find((s) => s.handle === 'openrx');
    const band = /(\d(?:\.\d)?) GHz/.exec(rx?.caption ?? '')?.[1];
    assert.ok(band, 'the receiver caption names its band');
    for (const option of Object.keys(PRODUCT_CONTENT.openrx?.variants ?? {}))
      assert.match(specOf('openrx', option, 'Band') ?? '', new RegExp(`${band.replace('.', '\\.')} GHz`), option);
  });

  it('has a phone still for every step', () => {
    for (const s of steps)
      assert.ok(
        existsSync(new URL(`../../public/models/od3/tour/${s.id}.webp`, import.meta.url)),
        `public/models/od3/tour/${s.id}.webp (npm run gen:tour-stills)`,
      );
  });

  it('keeps CAD part names out of the tour', () => {
    const text = JSON.stringify(studio.beats) + JSON.stringify(studio.boards);
    assert.doesNotMatch(text, /OpenFC-Lite-Mini|OpenESC-20x20/);
  });
});
