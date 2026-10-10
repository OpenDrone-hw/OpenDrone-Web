import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  figureAllowed,
  makeTesting,
  normalizeTier,
  type Figure,
  type TimelineItem,
} from './testing-content.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/testing-content.test.ts

const DIR = new URL('../../content/testing/', import.meta.url);
const read = (n: string): any => JSON.parse(fs.readFileSync(new URL(n, DIR), 'utf8'));
const figures = read('figures.json').figures as Figure[];
const items = read('timeline.json').items as TimelineItem[];

const base = figures[0]!;
const make = (over: Partial<Figure>): Figure => ({...base, ...over});

describe('figureAllowed', () => {
  it('drops needs-review figures', () => {
    assert.equal(figureAllowed(make({status: 'needs-review'})), false);
  });
  it('drops simulated captures', () => {
    assert.equal(
      figureAllowed(make({source: {...base.source, simulated: true}})),
      false,
    );
  });
  it('drops a thrust stand figure that plots current', () => {
    const f = make({
      source: {...base.source, run: 'drv-04-x', kind: 'thrust-stand'},
      series: [{...base.series[0]!, field: 'i_a'}],
    });
    assert.equal(figureAllowed(f), false);
  });
  it('drops a thrust stand figure with a power or ampere axis', () => {
    const f = make({
      source: {...base.source, run: 'drv-04-x', kind: 'thrust-stand'},
      y: {label: 'Power', unit: 'W', scale: 'linear'},
    });
    assert.equal(figureAllowed(f), false);
  });
  it('keeps current on a clamp-referenced bench run', () => {
    assert.equal(figureAllowed(make({})), true);
  });
});

describe('published data', () => {
  const t = makeTesting(figures, items);
  it('has at most one featured figure per product', () => {
    for (const p of new Set(figures.map((f) => f.product))) {
      const n = figures.filter(
        (f) => f.product === p && f.featured && f.status === 'publish',
      ).length;
      assert.ok(n <= 1, `${p} has ${n} featured figures`);
    }
  });
  it('has one featured figure for each chapter product', () => {
    for (const p of ['openesc', 'openmotor', 'openrx', 'openfc-lite']) {
      assert.ok(t.getFeatured(p), `${p} has no featured figure`);
    }
    assert.equal(t.getFeatured('openframe'), null);
  });
  it('caps every series at 400 points', () => {
    for (const f of figures) {
      for (const s of f.series) assert.ok(s.points.length <= 400, f.id);
    }
  });
  it('never returns a needs-review item', () => {
    assert.ok(t.getTimeline().every((i) => i.status === 'publish'));
    assert.ok(t.productsWithData().length > 0);
    for (const p of t.productsWithData()) {
      assert.ok(t.getFigures(p).every((f) => f.status === 'publish'));
    }
  });
  it('sorts the timeline newest first', () => {
    const d = t.getTimeline().map((i) => i.date);
    assert.deepEqual(d, [...d].sort().reverse());
  });
  it('matches a tier across 20x20 and 20×20', () => {
    assert.equal(normalizeTier('20×20'), '20x20');
    assert.ok(t.getFeatured('openesc', '20×20'));
    assert.equal(t.getFeatured('openesc', '30×30'), null);
  });
});
