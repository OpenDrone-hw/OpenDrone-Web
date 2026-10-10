import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decimateSeries} from './decimate.ts';
import {buildGeometry} from './geometry.ts';
import {alignSeries, figureDomains, niceTicks} from './scale.ts';
import {normalizeTier, pickFeatured, summarize} from './select.ts';
import type {Fig, TestingIndex} from './types.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/testing/testing.test.ts

const DIR = new URL('../../../public/testing/', import.meta.url);
const index = JSON.parse(fs.readFileSync(new URL('index.json', DIR), 'utf8')) as TestingIndex;
const fig = (id: string) => JSON.parse(fs.readFileSync(new URL(`fig/${id}.json`, DIR), 'utf8')) as Fig;

describe('published figures', () => {
  it('every figure has a setup chip and its run is known', () => {
    for (const [id, s] of Object.entries(index.figures)) {
      assert.ok(s.chip.trim().length > 0, id);
      assert.ok(index.runs[s.runId], `${id} run`);
      assert.ok(fig(id).chip.trim().length > 0, `${id} json chip`);
    }
  });

  it('the thrust chip states the reference mass, one motor on two packs and the reversed ESC', () => {
    const c = index.figures['openmotor-thrust-vs-rpm']!.chip;
    assert.match(c, /1726 g/);
    assert.match(c, /two 6S packs/);
    assert.match(c, /ESC reversed/);
    const setup = index.runs[index.figures['openmotor-thrust-vs-rpm']!.runId]!.setup.join(' ');
    assert.match(setup, /207\.4 counts\/g/);
  });

  it('the thrust figure has one frame per rotor speed reading and holds are markers only', () => {
    const f = fig('openmotor-thrust-vs-rpm');
    const frames = f.series.filter((s) => s.kind === 'frames');
    for (const s of frames) {
      assert.equal(new Set(s.x).size, s.x.length, 'no two frames share an rpm value');
    }
    assert.ok(f.fit && f.fit.k > 1.6 && f.fit.k < 1.8, 'the 1.7 g per krpm squared claim is drawn');
    const g = buildGeometry(f, {w: 1200, h: 480});
    for (const s of g.series.filter((q) => q.kind === 'hold')) {
      assert.equal(s.d, undefined, 'no connecting line');
      assert.ok(s.dots.length > 0);
      assert.ok(s.bars.length > 0);
    }
  });

  it('thrust-stand figures expose no current or power', () => {
    for (const id of index.products.find((p) => p.handle === 'openmotor')!.figures) {
      const f = fig(id);
      for (const s of f.series) assert.notEqual(s.quantity, 'current', id);
      assert.doesNotMatch(f.axes.y.unit, /^(A|W)$/);
    }
  });

  it('keeps null readings as gaps', () => {
    const f = fig('openesc-die-temp-ramp');
    const g = buildGeometry(f, {w: 700, h: 380});
    const clamp = g.series.find((s) => s.id === 's1.i_clamp')!;
    assert.ok((clamp.d!.match(/M/g) ?? []).length > 1, 'path breaks at missing readings');
  });
});

describe('scale and decimation', () => {
  it('ticks are round and inside the range', () => {
    const t = niceTicks(0, 29762, 6);
    assert.deepEqual(t.slice(0, 3), [0, 5000, 10000]);
    assert.ok(t.every((v) => v <= 29762));
  });

  it('min/max bucketing keeps a single-sample spike', () => {
    const n = 5000;
    const x = Array.from({length: n}, (_, i) => i);
    const y = x.map((i) => (i === 2503 ? 999 : 1));
    const d = decimateSeries({id: 'a', label: 'a', quantity: 'aux', kind: 'trace', x, y}, 400);
    assert.ok(d.x.length <= 800);
    assert.ok(d.y.includes(999));
  });

  it('aligns series on one sorted x array without inventing readings', () => {
    const a = alignSeries([
      {id: 'a', label: 'a', quantity: 'aux', kind: 'trace', x: [1, 3], y: [10, 30]},
      {id: 'b', label: 'b', quantity: 'aux', kind: 'trace', x: [2, 3], y: [null, 5]},
    ]);
    assert.deepEqual(a.x, [1, 2, 3]);
    assert.deepEqual(a.ys[0], [10, undefined, 30]);
    assert.deepEqual(a.ys[1], [undefined, null, 5]);
  });

  it('domains honour fixed axis limits and follow an x window', () => {
    const f = fig('openmotor-thrust-vs-rpm');
    const full = figureDomains(f);
    assert.equal(full.y[0], 0);
    const win = figureDomains(f, {xWindow: [12000, 18000]});
    assert.ok(win.y[1] < full.y[1]);
  });
});

describe('selection', () => {
  it('normalizes tiers', () => {
    assert.equal(normalizeTier('20×20'), '20x20');
  });
  it('picks the featured figure by tier and summarizes', () => {
    assert.equal(pickFeatured(index, 'openmotor')?.id, 'openmotor-thrust-vs-rpm');
    assert.equal(pickFeatured(index, 'openesc', '30x30'), null);
    assert.equal(pickFeatured(index, 'openesc', '20x20')?.id, 'openesc-shunt-vs-clamp');
    assert.equal(summarize(index).figures, Object.keys(index.figures).length);
  });

  it('both y axes of a dual-axis figure share their gridlines', () => {
    const f = fig('openesc-die-temp-ramp');
    const d = figureDomains(f);
    assert.ok(d.n && d.y2);
    assert.ok(d.y2![0] >= 0, 'no empty negative current range');
    const g = buildGeometry(f, {w: 1000, h: 400});
    assert.deepEqual(g.yTicks.map((t) => t.p), g.y2Ticks.map((t) => t.p));
  });
});
