import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Run with:
//   node --experimental-strip-types --test app/lib/testing-data.test.ts
//
// Pins the data contract of content/testing/*.json, which
// scripts/sync-testing.mjs writes from the bench app. The runtime guards in
// the loader are a second line; this is the first: a regenerated file that
// breaks the contract fails here before it can ship.

const DIR = new URL('../../content/testing/', import.meta.url);
const read = <T>(name: string): T => JSON.parse(fs.readFileSync(new URL(name, DIR), 'utf8')) as T;

type Point = [number, number];
type Series = {
  id: string;
  name: string;
  role: string;
  style: string;
  field: string;
  points: Point[];
  band?: {lo: Point[]; hi: Point[]};
};
type Figure = {
  id: string;
  product: string;
  tier: string | null;
  kind: string;
  featured: boolean;
  status: string;
  x: {label: string; unit: string; scale: string};
  y: {label: string; unit: string; scale: string};
  y2?: {label: string; unit: string; scale: string};
  series: Series[];
  setup: string;
  finding: string;
  caveats: string[];
  source: {run: string; kind: string; recorded: string; simulated: boolean; reduction: string};
};
type Item = {
  id: string;
  date: string;
  product: string;
  tested: string;
  saw: string;
  changed: string | null;
  figureId?: string;
  commit?: string;
  status: string;
};

const figuresFile = read<{schema: number; figures: Figure[]}>('figures.json');
const timelineFile = read<{schema: number; items: Item[]}>('timeline.json');
const figures: Figure[] = figuresFile.figures;
const items: Item[] = timelineFile.items;
const meta = read<{generated: string; sourceRevision: string; schema: number; source: string}>('meta.json');

const PRODUCTS = ['openesc', 'openmotor', 'openrx', 'openfc-lite', 'openframe'];
const THRUST_STAND_FIELDS = ['rpm', 'thrust_g', 'thr', 'thr_pct', 'v_bus', 'tesc_max'];
const BANNED_TEXT = [
  /\/Volumes/,
  /Private/,
  /siliXcon/,
  /\bCE\b/,
  /EN 300/,
  /OpenFC-Core/,
  /[€$£]\s?\d|\d\s?(€|EUR\b|USD\b)/,
  /LCSC/,
  /—/,
  /\/Users\//,
];

describe('content/testing files', () => {
  it('declare schema 1 and a source', () => {
    assert.equal(figuresFile.schema, 1);
    assert.equal(timelineFile.schema, 1);
    assert.equal(meta.schema, 1);
    assert.match(meta.generated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['app', 'file-fallback', 'mixed'].includes(meta.source));
    assert.ok(typeof meta.sourceRevision === 'string' && meta.sourceRevision.length > 0);
  });

  it('stay under 300 KB each', () => {
    for (const name of fs.readdirSync(DIR)) {
      assert.ok(fs.statSync(new URL(name, DIR)).size < 300 * 1024, `${name} is too large`);
    }
  });

  it('carry no banned string, path, name or em dash', () => {
    for (const name of fs.readdirSync(DIR)) {
      const text = fs.readFileSync(new URL(name, DIR), 'utf8');
      for (const re of BANNED_TEXT) assert.ok(!re.test(text), `${name} matches ${re}`);
    }
  });

  it('carry none of the fields the exporter strips', () => {
    const text = fs.readFileSync(new URL('figures.json', DIR), 'utf8');
    for (const key of ['raw_points', 'raw_count', 'cites', '"color"', '"width"', '"operator"']) {
      assert.ok(!text.includes(key), `figures.json contains ${key}`);
    }
  });
});

describe('figures', () => {
  it('have unique kebab-case ids and a known product', () => {
    const ids = new Set<string>();
    for (const f of figures) {
      assert.match(f.id, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.ok(!ids.has(f.id), `duplicate ${f.id}`);
      ids.add(f.id);
      assert.ok(PRODUCTS.includes(f.product), `${f.id}: product ${f.product}`);
      assert.ok(f.tier === null || ['20x20', '30x30'].includes(f.tier), `${f.id}: tier`);
      assert.ok(['line', 'scatter', 'band'].includes(f.kind));
      assert.ok(['publish', 'needs-review'].includes(f.status));
    }
  });

  it('have at most one published featured figure per product', () => {
    const count = new Map<string, number>();
    for (const f of figures) {
      if (f.featured && f.status === 'publish') count.set(f.product, (count.get(f.product) ?? 0) + 1);
    }
    for (const [p, n] of count) assert.equal(n, 1, `${p} has ${n} featured figures`);
    // A product with a chapter has exactly one.
    for (const p of ['openesc', 'openmotor', 'openrx', 'openfc-lite']) {
      assert.equal(count.get(p), 1, `${p} has no featured figure`);
    }
  });

  it('have units on every axis and finite, ascending points under the cap', () => {
    for (const f of figures) {
      for (const ax of [f.x, f.y, ...(f.y2 ? [f.y2] : [])]) {
        assert.ok(ax.label && ax.unit, `${f.id}: axis needs a label and a unit`);
        assert.ok(['linear', 'log'].includes(ax.scale));
      }
      assert.ok(f.series.length > 0, `${f.id}: no series`);
      for (const s of f.series) {
        assert.ok(['measured', 'reference'].includes(s.role), `${f.id}/${s.id}: role`);
        assert.ok(['solid', 'dashed', 'points'].includes(s.style), `${f.id}/${s.id}: style`);
        assert.ok(s.points.length > 0 && s.points.length <= 400, `${f.id}/${s.id}: ${s.points.length} points`);
        let last = -Infinity;
        for (const [x, y] of s.points) {
          assert.ok(Number.isFinite(x) && Number.isFinite(y), `${f.id}/${s.id}: non-finite point`);
          assert.ok(x >= last, `${f.id}/${s.id}: x not ascending`);
          last = x;
        }
        if (s.band) {
          assert.equal(s.band.lo.length, s.points.length, `${f.id}/${s.id}: band lo`);
          assert.equal(s.band.hi.length, s.points.length, `${f.id}/${s.id}: band hi`);
        }
      }
    }
  });

  it('keep points to 4 significant digits', () => {
    for (const f of figures) {
      for (const s of f.series) {
        for (const [x, y] of s.points) {
          assert.equal(Number(x.toPrecision(4)), x, `${f.id}/${s.id}: x ${x}`);
          assert.equal(Number(y.toPrecision(4)), y, `${f.id}/${s.id}: y ${y}`);
        }
      }
    }
  });

  it('state setup, finding, caveats and a real, non-simulated source', () => {
    for (const f of figures) {
      assert.ok(f.setup && f.finding && f.caveats.length > 0, `${f.id}: prose`);
      assert.equal(f.source.simulated, false, `${f.id}: simulated`);
      assert.ok(f.source.run && f.source.reduction, `${f.id}: source`);
      assert.match(f.source.recorded, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(['bench', 'thrust-stand', 'field-ride', 'flight-log'].includes(f.source.kind));
    }
  });

  it('export only calibrated quantities from the thrust stand', () => {
    const stand = figures.filter((f) => f.source.run.startsWith('drv-04-'));
    assert.ok(stand.length > 0, 'expected thrust stand figures');
    for (const f of stand) {
      for (const s of f.series) {
        assert.ok(THRUST_STAND_FIELDS.includes(s.field), `${f.id}/${s.id}: ${s.field}`);
      }
      assert.ok(!['A', 'W', 'g/W'].includes(f.y.unit), `${f.id}: y unit ${f.y.unit}`);
      const text = JSON.stringify(f);
      assert.ok(!/i_a|i_shunt|p_shunt|eff_gw|clamp_a|watt|g\/W/i.test(text), `${f.id}: banned field name`);
      assert.ok(!/\b(current|power|efficiency)\b/i.test(text), `${f.id}: mentions current, power or efficiency`);
    }
  });

  it('keep the four founder decisions out of publishable text', () => {
    const text = JSON.stringify([
      figures.filter((f) => f.status === 'publish'),
      items.filter((i) => i.status === 'publish'),
    ]);
    assert.ok(!/rev3\.1/.test(text), 'rev3.1 label');
    assert.ok(!/\bfix(es|ed)? (the|it)\b/i.test(text), 'a "fixed" claim about the current sense');
    assert.ok(!/\bFail\b/.test(text), 'a verdict word');
    assert.ok(!/overshoot/i.test(text), 'the overshoot finding');
  });
});

describe('timeline', () => {
  const ids = new Set(figures.map((f) => f.id));

  it('has unique ids, ISO dates, known products and valid references', () => {
    const seen = new Set<string>();
    for (const i of items) {
      assert.ok(!seen.has(i.id), `duplicate ${i.id}`);
      seen.add(i.id);
      assert.match(i.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(PRODUCTS.includes(i.product));
      assert.ok(i.tested && i.saw, `${i.id}: tested and saw`);
      assert.ok(i.changed === null || typeof i.changed === 'string');
      assert.ok(['publish', 'needs-review'].includes(i.status));
      if (i.figureId) assert.ok(ids.has(i.figureId), `${i.id}: unknown figure ${i.figureId}`);
      if (i.commit) assert.match(i.commit, /^[0-9a-f]{7,40}$/);
    }
  });

  it('is sorted newest first', () => {
    const dates = items.map((i) => i.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
  });
});
