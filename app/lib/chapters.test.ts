import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTER_TYPES,
  DEFAULT_CHAPTERS,
  chaptersFor,
  resolveChapters,
  type ChapterEntry,
  type ChapterType,
} from './chapters.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/chapters.test.ts
//
// The bug this module exists to kill: the old `computeChapterNumbers` was a
// hand-maintained copy of the render order, and its own comment asked whoever
// touched it to "keep the two in step". These tests pin the property that
// replaces that request with a guarantee.

const all = () => true;
const none = () => false;

describe('DEFAULT_CHAPTERS', () => {
  it('only names types the renderer knows', () => {
    for (const c of DEFAULT_CHAPTERS) {
      assert.ok(
        (CHAPTER_TYPES as readonly string[]).includes(c.type),
        `${c.type} is not a chapter type`,
      );
    }
  });

  it('has unique ids, so drag-and-drop cannot move the wrong row', () => {
    const ids = DEFAULT_CHAPTERS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('is the order the page was designed in', () => {
    // Guards the argument the page makes: what this even is, then published,
    // then made of, then measures, then ships, then who built it.
    assert.deepEqual(
      DEFAULT_CHAPTERS.map((c) => c.type),
      [
        'whatIsThis',
        'openSource',
        'teardown',
        'specs',
        'inTheBox',
        'downloads',
        'firmware',
        'contributors',
        'reviews',
      ],
    );
  });
});

describe('resolveChapters numbering', () => {
  it('numbers contiguously from 01, zero-padded', () => {
    const out = resolveChapters(null, all);
    assert.deepEqual(
      out.map((c) => c.number),
      ['01', '02', '03', '04', '05', '06', '07', '08', '09'],
    );
  });

  it('never leaves a gap when a chapter is absent', () => {
    // The old failure was "03, 05" when a predicate was skipped in one place
    // and not the other. Numbering is now derived, so this cannot happen.
    const skipTeardown = (t: ChapterType) => t !== 'teardown';
    const out = resolveChapters(null, skipTeardown);
    assert.deepEqual(
      out.map((c) => c.number),
      ['01', '02', '03', '04', '05', '06', '07', '08'],
    );
    assert.ok(!out.some((c) => c.type === 'teardown'));
  });

  it('numbers follow position, so a reorder renumbers automatically', () => {
    const out = resolveChapters(null, all);
    out.forEach((c, i) => {
      assert.equal(c.number, String(i + 1).padStart(2, '0'));
    });
  });

  it('skips chapters switched off without renumbering around them', () => {
    // `enabled: false` and "no content" must be indistinguishable in the
    // output, or a hidden chapter would burn a number.
    const list: ChapterEntry[] = [
      {id: 'a', type: 'specs'},
      {id: 'b', type: 'downloads', enabled: false},
      {id: 'c', type: 'reviews'},
    ];
    const out: Array<ChapterEntry & {number: string}> = [];
    let n = 1;
    for (const e of list) {
      if (e.enabled === false) continue;
      out.push({...e, number: String(n++).padStart(2, '0')});
    }
    assert.deepEqual(
      out.map((c) => [c.id, c.number]),
      [
        ['a', '01'],
        ['c', '02'],
      ],
    );
  });

  it('an accessory with nothing to show renders no chapters, not empty numbers', () => {
    assert.deepEqual(resolveChapters('battery-strap', none), []);
  });

  it('passes the entry to the presence test, so a prose chapter can be judged by id', () => {
    const seen: string[] = [];
    resolveChapters(null, (_t, e) => {
      seen.push(e.id);
      return true;
    });
    assert.deepEqual(seen, DEFAULT_CHAPTERS.map((c) => c.id));
  });
});

describe('chaptersFor', () => {
  it('falls back to the designed order for an unknown handle', () => {
    assert.deepEqual(chaptersFor('no-such-product'), DEFAULT_CHAPTERS);
    assert.deepEqual(chaptersFor(null), DEFAULT_CHAPTERS);
    assert.deepEqual(chaptersFor(undefined), DEFAULT_CHAPTERS);
  });

  it('always returns a usable list', () => {
    // The contract the route depends on: never empty, never malformed, so a
    // bad config file cannot blank a product page in production.
    const out = chaptersFor('openfc-lite');
    assert.ok(Array.isArray(out) && out.length > 0);
    for (const c of out) {
      assert.equal(typeof c.id, 'string');
      assert.ok((CHAPTER_TYPES as readonly string[]).includes(c.type));
    }
  });
});
