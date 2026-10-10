import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decimateSeries} from './decimate.ts';
import {buildGeometry, placeLabels} from './geometry.ts';
import {alignSeries, figureDomains, fmtTickSet, niceTicks, unitLabel} from './scale.ts';
import {normalizeTier, pickFeatured, summarize} from './select.ts';
import {numberFigures} from './layout.ts';
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

  it('the thrust chip states the reference mass and one motor on one pack, and not the unrecorded ESC direction', () => {
    const c = index.figures['openmotor-thrust-vs-rpm']!.chip;
    assert.match(c, /1726 g/);
    assert.match(c, /one 6S pack/);
    assert.doesNotMatch(c, /reversed/);
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

describe('axis labels', () => {
  it('writes one axis in one form: k from 5000 up, plain below', () => {
    assert.deepEqual(fmtTickSet([0, 5000, 10000, 15000]), ['0', '5k', '10k', '15k']);
    assert.deepEqual(fmtTickSet([2500, 3000, 3500]).length, 3);
    assert.deepEqual(fmtTickSet([2500, 3000, 3500]), ['2500', '3000', '3500']);
    assert.deepEqual(fmtTickSet([0, 500, 1000, 1500]), ['0', '500', '1000', '1500']);
    assert.deepEqual(fmtTickSet([0, 2500, 5000, 7500]), ['0', '2.5k', '5k', '7.5k']);
    assert.deepEqual(fmtTickSet([18, 20, 22, 24]), ['18', '20', '22', '24']);
  });
  it('writes degC as a degree sign', () => {
    assert.equal(unitLabel('degC'), '°C');
    assert.equal(unitLabel('rpm'), 'rpm');
  });
});

describe('end labels', () => {
  const bounds = {x0: 0, y0: 0, x1: 300, y1: 200};
  const overlap = (a: {left: number; top: number; w: number; h: number}, x: number, y: number, r: number) =>
    a.left < x + r && a.left + a.w > x - r && a.top < y + r && a.top + a.h > y - r;
  it('never sits on a marker, on another label or outside the plot', () => {
    const labels = [
      {x: 290, y: 20, w: 70, h: 13},
      {x: 288, y: 34, w: 70, h: 13},
      {x: 150, y: 100, w: 70, h: 13},
    ];
    const markers: Array<[number, number]> = [[290, 20], [288, 34], [150, 100], [200, 105], [140, 90]];
    const placed = placeLabels(labels, markers, bounds);
    placed.forEach((r, i) => {
      assert.ok(r.left >= 0 && r.left + r.w <= 300 && r.top >= 0 && r.top + r.h <= 200, `label ${i} inside`);
      for (const [x, y] of markers) assert.ok(!overlap(r, x, y, 4), `label ${i} clear of marker ${x},${y}`);
      for (let j = 0; j < i; j++) {
        const o = placed[j]!;
        assert.ok(r.left >= o.left + o.w || o.left >= r.left + r.w || r.top >= o.top + o.h || o.top >= r.top + r.h, `labels ${i} and ${j} apart`);
      }
    });
  });
});

describe('the OpenMotor section', () => {
  const previews = Object.fromEntries(Object.keys(index.figures).map((id) => [id, fig(id)]));
  const motor = () => index.products.find((p) => p.handle === 'openmotor')!;
  it('numbers its figures in document order, the thrust against rpm figure first', () => {
    const nums = numberFigures(index, (id) => Boolean(previews[id])).filter((n) => motor().figures.includes(n.id));
    assert.equal(nums[0]!.id, 'openmotor-thrust-vs-rpm');
    assert.deepEqual(nums.map((n) => n.no), nums.map((_, i) => nums[0]!.no + i));
    assert.ok(!nums.some((n) => n.id === 'openmotor-hold-rpm' && index.figures[n.id]!.duplicateOf));
  });
  it('draws the clean 16:48 run on every figure and the earlier packs only where they compare packs', () => {
    for (const id of Object.keys(index.figures).filter((i) => i.startsWith('openmotor-'))) {
      const labels = fig(id).series.map((s) => s.label);
      assert.ok(labels.some((l) => /^Clean run, 16:48/.test(l)), `${id} clean run`);
      const both = /thrust per throttle|Thrust per throttle|pack voltage/i.test(fig(id).title);
      assert.equal(labels.some((l) => /^Pack [AB]/.test(l)), both, `${id} earlier packs`);
    }
  });
  it('never plots the 16:35 run and says why', () => {
    for (const id of Object.keys(index.figures).filter((i) => i.startsWith('openmotor-'))) {
      assert.ok(!fig(id).series.some((s) => /16:35/.test(s.label)), id);
    }
    assert.match(index.runs[index.figures['openmotor-thrust-vs-rpm']!.runId]!.setup.join(' '), /16:35 UTC is not plotted/);
  });
  it('states that full-throttle thrust depends on the pack, flagged', () => {
    const c = fig('openmotor-hold-thrust').caveats.find((x) => /sagged to 19\.3 V/.test(typeof x === 'string' ? x : x.text));
    assert.ok(c && typeof c !== 'string' && c.flag, 'flagged');
  });
  it('uses 31283 rpm and a quadratic fit in the findings', () => {
    assert.match(index.figures['openmotor-hold-rpm']!.finding, /31283 rpm/);
    assert.match(index.figures['openmotor-thrust-vs-rpm']!.finding, /quadratic fit gives 1\.68 g per krpm squared/);
  });
});

describe('the log', () => {
  it('names the operator pulling the pack as the cause', () => {
    const e = index.log.find((l) => l.id === 'motor-thrust-map-bus-loss')!;
    assert.match(e.saw, /unplugged the pack/);
  });
});

describe('headline numbers and round 3 rules', () => {
  const at = (id: string, sid: RegExp, x: number) => {
    const s = fig(id).series.find((q) => q.kind === 'hold' && sid.test(q.label))!;
    return s.y[s.x.indexOf(x)]!;
  };
  it('pins thrust, rotor speed, voltage, temperature, the fit and the 70 percent voltage gap', () => {
    assert.ok(Math.abs(at('openmotor-hold-thrust', /Clean run/, 100) - 1652.2) < 0.5);
    assert.ok(Math.abs(at('openmotor-hold-thrust', /Pack B/, 100) - 1496.2) < 0.5);
    assert.ok(Math.abs(at('openmotor-hold-rpm', /Clean run/, 100) - 31283) < 1);
    assert.ok(Math.abs(at('openmotor-hold-pack-voltage', /Pack B/, 100) - 19.264) < 0.01);
    assert.ok(Math.abs(at('openmotor-hold-pack-voltage', /Clean run/, 10) - 23.912) < 0.01);
    assert.equal(at('openmotor-hold-esc-temp', /Clean run/, 100), 53);
    assert.equal(fig('openmotor-thrust-vs-rpm').fit!.k, 1.68);
    const gap = at('openmotor-hold-pack-voltage', /Pack A/, 70) - at('openmotor-hold-pack-voltage', /Pack B/, 70);
    assert.ok(gap > 1.8 && gap < 1.95, `gap ${gap}`);
  });
  it('a figure with four runs of one quantity gives each its own colour', async () => {
    const {assignStyles} = await import('./palette.ts');
    const f = fig('openfc-lite-flight-die-temp');
    const st = assignStyles(f.series, 'light');
    assert.equal(new Set(f.series.map((s) => st[s.id]!.color)).size, 4);
  });
  it('a reading that starts near zero gets no empty axis below zero', () => {
    assert.ok(figureDomains(fig('openesc-shunt-vs-clamp')).y[0] >= 0);
  });
  it('marks sit on published points and hold figures join their markers unless a fit is drawn', async () => {
    const f = fig('openmotor-thrust-vs-rpm');
    assert.equal(fig('openmotor-hold-thrust').marks?.[0]?.kind, 'line');
    const g = buildGeometry(fig('openesc-shunt-vs-clamp'), {w: 700, h: 380});
    assert.ok(g.series.every((s) => s.d), 'holds are joined');
    assert.ok(buildGeometry(f, {w: 1000, h: 480}).series.filter((s) => s.kind === 'hold').every((s) => !s.d));
  });
});

describe('page wording comes from the views', () => {
  it('no figure or run wording is written in the storefront code', () => {
    const files = ['layout.ts', 'labels.ts', 'data.server.ts', 'select.ts'];
    for (const f of files) {
      const text = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      assert.doesNotMatch(text, /pole pairs|Pack [AB]\b|OpenMotor|UTC run|13:\d\d|calibrated|unplugged/, f);
    }
  });

  it('the card caveat, axis note, tiles and photo are published as data', () => {
    assert.match(fig('openmotor-hold-thrust').cardCaveat ?? '', /sagged to 19\.3 V/);
    assert.equal(fig('openmotor-thrust-vs-rpm').axes.x.note, '7 pole pairs assumed');
    assert.equal(index.figures['openmotor-hold-rpm']!.duplicateOf, 'openmotor-thrust-vs-rpm');
    const tiles = Object.values(index.figures).filter((f) => f.tile);
    assert.equal(tiles.length, 4);
    const photo = index.runs[index.figures['openmotor-thrust-vs-rpm']!.runId]!.photo!;
    assert.ok(photo.size[0] <= 1600);
    assert.ok(fs.existsSync(new URL(`.${photo.src.replace(/^\/testing/, '')}`, DIR)), 'photo file');
  });
});
