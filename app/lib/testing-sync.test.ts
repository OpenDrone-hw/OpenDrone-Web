import {describe, it, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {
  buildFigure,
  buildIndex,
  compileConfig,
  decimate,
  holdLast,
  loadBench,
  runChecks,
  statOf,
  validateLog,
  validatePublish,
} from '../../scripts/testing-export-lib.mjs';

// Run with:
//   node --experimental-strip-types --test app/lib/testing-sync.test.ts
//
// Covers scripts/sync-testing.mjs: the reading of `publish` blocks, the honesty
// gate (each fixture below must fail the build), the statistics that pin a
// finding, the stand holds, and the contract of the files it writes. The
// end-to-end cases run the real CLI against a fake bench app on localhost, so
// nothing here reaches the real app or a rig.

const J = (text: string): any => JSON.parse(text);
const bi = (...args: any[]): any => (buildIndex as any)(...args);
const build = (...args: any[]): any => (buildFigure as any)(...args);
const WEB = new URL('../../', import.meta.url).pathname;
const CFG: any = compileConfig(J(fs.readFileSync(path.join(WEB, 'scripts/testing-export.config.json'), 'utf8')));

// ------------------------------------------------------------------ fixtures

const block = (over: any = {}) => ({
  status: 'publish',
  title: 'Current against throttle',
  product: 'openesc',
  run: 'esc-99-2026-01-01',
  domain: 'PWR',
  finding: 'Current reads 10 A at 50 percent throttle.',
  setup: ['1 OpenESC-20x20, 1 motor'],
  setup_chip: 'OpenESC-20x20, 1 motor',
  caveats: ['One unit, one run.'],
  order: 10,
  featured: true,
  checks: [{series: 's1.i', stat: 'at', x: 50, xtol: 0.1, min: 9.9, max: 10.1}],
  by: 'operator',
  at: '2026-01-01',
  ...over,
});

const view = (over: any = {}, pub: any = {}) => ({
  id: 'esc-current',
  sources: [{id: 's1', ref: 'log:esc-99-20x20-20260101T000000Z', label: 's1', enabled: true}],
  x: {field: 'thr', scale: 'linear'},
  series: [{id: 's1.i', source: 's1', field: 'i_clamp', name: 'Current', axis: 'left', visible: true}],
  reduce: 'frames',
  publish: block(pub),
  ...over,
});

/** The app's answer for the fixture view: ten points, x = 0..90 percent. */
const answer = (over: any = {}) => ({
  simulated: false,
  x: {unit: 'percent', label: 'Throttle'},
  axes: {left: {unit: 'A', label: 'Current'}},
  series: [{id: 's1.i', points: Array.from({length: 10}, (_, i) => [i * 10, i * 0.2 + 9]), band: {lo: [], hi: []}}],
  citations: [{folder: 'Logs/esc-99', l0: 2, l1: 100, ref: 'Logs/esc-99#L2-L100'}],
  provenance: {sources: [{recorded: '2026-01-01T10:00:00+00:00'}]},
  ...over,
});

const noBenches = new Map();
const errorsOf = (v: any, a: any = answer()) => build(v, a, noBenches, CFG).errors.join('\n');

// ------------------------------------------------------------------ the gate

describe('validatePublish', () => {
  it('accepts a complete block', () => {
    assert.deepEqual(validatePublish(view(), CFG), []);
  });
  it('rejects an empty finding, setup or chip', () => {
    assert.match(validatePublish(view({}, {finding: ' '}), CFG).join(), /finding is empty/);
    assert.match(validatePublish(view({}, {setup: []}), CFG).join(), /setup is empty/);
    assert.match(validatePublish(view({}, {setup_chip: ''}), CFG).join(), /setup_chip is empty/);
  });
  it('rejects a finding over 25 words and a title outside 3 to 6 words', () => {
    assert.match(validatePublish(view({}, {finding: Array(26).fill('word').join(' ')}), CFG).join(), /limit 25/);
    assert.match(validatePublish(view({}, {title: 'Too short'}), CFG).join(), /title is 2 words/);
    assert.match(validatePublish(view({}, {title: 'This title is much too long again'}), CFG).join(), /title is 7 words/);
  });
  it('needs by and at to publish, and refuses an agent as by', () => {
    assert.match(validatePublish(view({}, {by: ''}), CFG).join(), /by and at/);
    assert.match(validatePublish(view({}, {at: ''}), CFG).join(), /by and at/);
    assert.match(validatePublish(view({}, {by: 'Claude agent'}), CFG).join(), /names an agent/);
  });
  it('lets needs-review skip by and at', () => {
    assert.deepEqual(validatePublish(view({}, {status: 'needs-review', by: '', at: ''}), CFG), []);
  });
  it('requires a check when the finding quotes a number', () => {
    assert.match(validatePublish(view({}, {checks: []}), CFG).join(), /no check pins/);
  });
  it('refuses a source under the private tree', () => {
    const v = view({sources: [{id: 's1', ref: 'log:Private/acme/run', enabled: true}]});
    assert.match(validatePublish(v, CFG).join(), /private tree/);
  });
  it('refuses unknown product, domain and tier', () => {
    assert.match(validatePublish(view({}, {product: 'nope'}), CFG).join(), /unknown product/);
    assert.match(validatePublish(view({}, {domain: 'XYZ'}), CFG).join(), /domain/);
    assert.match(validatePublish(view({}, {tier: '99x99'}), CFG).join(), /bad tier/);
  });
});

describe('thrust stand rules', () => {
  const stand = (fields: string[], pub: any = {}, x = 'thr') =>
    view(
      {
        sources: [{id: 's1', ref: 'log:drv-04-thrust-2026-10-10-20261010T132503Z', enabled: true}],
        x: {field: x},
        series: fields.map((f) => ({id: `s1.${f}`, source: 's1', field: f, visible: true})),
      },
      {product: 'openmotor', domain: 'THR', title: 'Thrust at each hold', finding: 'Thrust is 1 g.', setup_chip: 'OpenMotor-2306 on a stand', setup: ['1 OpenMotor-2306'], checks: [{series: 's1.thrust_g', stat: 'max', min: 0, max: 1}], ...pub},
    );
  it('allows thrust, speed, throttle, pack voltage and temperature', () => {
    assert.deepEqual(validatePublish(stand(['thrust_g', 'rpm', 'v_bus', 'tesc_max']), CFG), []);
  });
  for (const f of ['i_clamp', 'i_shunt', 'p_bus', 'eff_gw', 'i_total', 'tesc1']) {
    it(`refuses ${f} on a stand run`, () => {
      assert.match(validatePublish(stand(['thrust_g', f]), CFG).join(), /may not export/);
    });
  }
  it('refuses current as the x field', () => {
    assert.match(validatePublish(stand(['thrust_g'], {}, 'i_clamp'), CFG).join(), /may not export i_clamp/);
  });
  for (const word of ['current', 'power', 'efficiency', 'g/W']) {
    it(`refuses the word "${word}" in the words of a stand figure`, () => {
      assert.match(validatePublish(stand(['thrust_g'], {caveats: [`The ${word} was high.`]}), CFG).join(), /current, power or efficiency/);
    });
  }
  it('does not apply to a bench run that has a clamp', () => {
    assert.deepEqual(validatePublish(view({}, {caveats: ['The clamp reads current.']}), CFG), []);
  });
});

describe('buildFigure gate', () => {
  it('builds the fixture', () => {
    const r = build(view(), answer(), noBenches, CFG);
    assert.deepEqual(r.errors, []);
    assert.equal(r.fig.series[0].x.length, 10);
    assert.equal(r.fig.runId, 'esc-99-2026-01-01');
    assert.equal(r.run.date, '2026-01-01');
    assert.equal(r.fig.cite, 'Logs/esc-99#L2-L100');
  });
  it('refuses a simulated answer', () => {
    assert.match(errorsOf(view(), answer({simulated: true})), /simulated/);
  });
  for (const [what, text] of [
    ['a volume path', '/Volumes/x'],
    ['the private tree', 'from Private data'],
    ['a supplier name', 'siliXcon part'],
    ['a compliance record', 'the CE mark'],
    ['a regulatory standard', 'EN 300 328'],
    ['the NDA component', 'OpenFC-Core'],
    ['a price', 'costs 12 EUR'],
    ['an em dash', 'one — two'],
    ['a home path', '/Users/x/file'],
  ] as const) {
    for (const where of ['finding', 'caveat', 'setup', 'chip', 'label']) {
      it(`refuses ${what} in the ${where}`, () => {
        const pub: any =
          where === 'finding'
            ? {finding: `Reads 10 A. ${text}`}
            : where === 'caveat'
              ? {caveats: [text]}
              : where === 'setup'
                ? {setup: [text]}
                : where === 'chip'
                  ? {setup_chip: text}
                  : {series: {'s1.i': {label: text}}};
        assert.match(errorsOf(view({}, pub)), /banned/);
      });
    }
  }
  it('fails when the data and the finding disagree', () => {
    const wrong = answer({series: [{id: 's1.i', points: [[50, 12]], band: {lo: [], hi: []}}]});
    assert.match(errorsOf(view(), wrong), /got 12, expected 9.9 to 10.1/);
  });
  it('fails when the app returns the wrong number of series', () => {
    assert.match(errorsOf(view(), answer({series: []})), /expected 1/);
  });
  it('keeps a gap as null and does not fill it', () => {
    const a = answer({series: [{id: 's1.i', points: [[0, 9], [50, null], [60, 10]]}]});
    const v = view({}, {checks: [{series: 's1.i', stat: 'at', x: 60, xtol: 0.1, min: 9.9, max: 10.1}]});
    const r = build(v, a, noBenches, CFG);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.fig.series[0].y, [9, null, 10]);
  });
  it('marks a caveat that starts with ! as flagged', () => {
    const r = build(view({}, {caveats: ['!Read this first.', 'Plain.']}), answer(), noBenches, CFG);
    assert.deepEqual(r.fig.caveats, [{text: 'Read this first.', flag: true}, {text: 'Plain.'}]);
  });
  it('scales x and checks the numbers as published', () => {
    const v = view({}, {display: {xScale: 0.1}, checks: [{series: 's1.i', stat: 'at', x: 5, xtol: 0.01, min: 9.9, max: 10.1}]});
    const r = build(v, answer({series: [{id: 's1.i', points: [[50, 10]]}]}), noBenches, CFG);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.fig.series[0].x, [5]);
  });
});

// ------------------------------------------------------------------ statistics

describe('checks', () => {
  const s = (id: string, x: number[], y: Array<number | null>) => ({id, x, y});
  const by: any = {
    a: s('a', [1, 2, 3, 4], [2, 4, 6, 8]),
    b: s('b', [1, 2, 3, 4], [1, 2, 4, 4]),
    g: s('g', [1, 2, 3], [5, null, 7]),
  };
  it('reads a value at x, the first, the max and the min', () => {
    assert.equal(statOf({series: 'a', stat: 'at', x: 3}, by), 6);
    assert.equal(statOf({series: 'a', stat: 'first'}, by), 2);
    assert.equal(statOf({series: 'a', stat: 'max'}, by), 8);
    assert.equal(statOf({series: 'a', stat: 'min', from: 2}, by), 4);
  });
  it('throws when no reading is near x', () => {
    assert.throws(() => statOf({series: 'g', stat: 'at', x: 2, xtol: 0.1}, by), /no reading/);
  });
  it('fits a slope', () => {
    assert.ok(Math.abs(statOf({series: 'a', stat: 'slope'}, by) - 2) < 1e-9);
  });
  it('reads a quadratic coefficient in y per krpm squared', () => {
    const q: any = {t: s('t', [10000, 20000, 30000], [1.7 * 100, 1.7 * 400, 1.7 * 900])};
    assert.ok(Math.abs(statOf({series: 't', stat: 'quad'}, q) - 1.7) < 1e-9);
  });
  it('counts differences and ratios over shared x', () => {
    assert.equal(statOf({series: 'a', stat: 'diff', with: 'b', metric: 'n'}, by), 4);
    assert.equal(statOf({series: 'b', stat: 'diff', with: 'a', metric: 'below'}, by), 4);
    assert.equal(statOf({series: 'a', stat: 'diff', with: 'b', metric: 'median'}, by), 2);
    assert.equal(statOf({series: 'a', stat: 'ratio', with: 'b', metric: 'max', minDen: 1.5}, by), 2);
    assert.equal(statOf({series: 'a', stat: 'ratio', with: 'b', metric: 'inside', within: [1.9, 2.1]}, by), 3);
  });
  it('reports each failing check by name', () => {
    const e = runChecks(
      [
        {series: 'a', stat: 'max', min: 8, max: 8},
        {series: 'a', stat: 'max', min: 0, max: 1},
        {series: 'nope', stat: 'max', min: 0, max: 1},
      ],
      by,
    );
    assert.equal(e.length, 2);
    assert.match(e[0], /got 8, expected 0 to 1/);
    assert.match(e[1], /unknown series nope/);
  });
});

// ------------------------------------------------------------------ resolution

describe('decimate', () => {
  const pts = (n: number) => Array.from({length: n}, (_, i) => ({x: i, y: Math.sin(i / 50), lo: null, hi: null}));
  it('leaves a series under the cap alone', () => {
    const p = pts(2000);
    assert.equal(decimate(p, 2500), p);
  });
  it('keeps a one-sample spike when thinning', () => {
    const p = pts(10000);
    p[4321]!.y = 50;
    const d = decimate(p, 2500);
    assert.ok(d.length <= 2500, `kept ${d.length}`);
    assert.ok(d.some((q: any) => q.y === 50));
    assert.equal(d[0], p[0]);
    assert.equal(d[d.length - 1], p[p.length - 1]);
  });
  it('keeps gaps', () => {
    const p = pts(6000);
    p[100]!.y = null as any;
    const d = decimate(p, 2500);
    assert.ok(d.some((q: any) => q.y === null && q.x === 100));
  });
  it('configures 2500 points per series', () => {
    assert.equal(CFG.maxPoints, 2500);
  });
});

// ------------------------------------------------------------------ stand holds

describe('stand holds from a capture', () => {
  let root = '';
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
    const dir = path.join(root, 'Logs', 'drv-04-fixture');
    fs.mkdirSync(dir, {recursive: true});
    const rows = ['# comment', 't_ms,thr1,erpm1,v_v,thrust_g,tesc1,tesc2,tesc3,tesc4'];
    // Two 4 s holds at 200 and 500 permille, then a ramp.
    for (let i = 0; i < 400; i++) rows.push(`${i * 10},200,${2000 + (i % 3)},24,${100 + (i % 4)},40,,,`);
    for (let i = 400; i < 800; i++) rows.push(`${i * 10},500,${6000},22,${300},50,,,`);
    fs.writeFileSync(path.join(dir, 'bench.csv'), rows.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({motor_poles: 14}));
  });
  after(() => fs.rmSync(root, {recursive: true, force: true}));
  const params = {seconds: 2, minDwellMs: 2000, drivenThrAbove: 5, dropBelowBusV: 5, band: true, motor: 1};

  it('takes the median and quartiles of the last 2 s of each hold', () => {
    const b = loadBench(root, 'drv-04-fixture');
    const h = holdLast(b, params, 'rpm', 'thrust_g');
    assert.equal(h.length, 2);
    assert.equal(h[1].y, 300);
    assert.equal(h[1].x, 6000 / 7);
    assert.ok(h[0].lo <= h[0].y && h[0].y <= h[0].hi);
    assert.equal(h[0].n, 200);
    assert.ok(h[0].l1 > h[0].l0);
  });
  it('drops holds with no pack voltage reading', () => {
    const b = loadBench(root, 'drv-04-fixture');
    const h = holdLast(b, {...params, dropBelowBusV: 23}, 'rpm', 'thrust_g');
    assert.equal(h.length, 1);
  });
  it('refuses a simulated capture', () => {
    const dir = path.join(root, 'Logs', 'drv-04-sim');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'bench.csv'), 't_ms,thr1\n0,0\n');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({simulated: true}));
    assert.throws(() => loadBench(root, 'drv-04-sim'), /simulated/);
  });
  it('builds hold series as markers with a band beside a frames trace', () => {
    const b = loadBench(root, 'drv-04-fixture');
    const v: any = view(
      {
        sources: [{id: 's1', ref: 'log:drv-04-fixture', enabled: true}],
        x: {field: 'rpm'},
        series: [{id: 's1.thrust_g', source: 's1', field: 'thrust_g', name: 'Run', visible: true}],
      },
      {
        product: 'openmotor',
        domain: 'THR',
        title: 'Thrust at each hold',
        setup_chip: 'OpenMotor-2306, fixture',
        setup: ['1 OpenMotor-2306'],
        run: 'drv-04-2026-01-01',
        holds: {...params, frames: true},
        checks: [{series: 's1.thrust_g.hold', stat: 'at', x: 857, xtol: 1, min: 299, max: 301}],
        finding: 'Thrust is 300 g at 857 rpm.',
        caveats: ['One capture.'],
        series: {'s1.thrust_g': {pack: 'A'}},
      },
    );
    const a = answer({series: [{id: 's1.thrust_g', points: [[1000, 100], [2000, 200], [1500, 150]]}]});
    const r = build(v, a, new Map([['drv-04-fixture', b]]), CFG);
    assert.deepEqual(r.errors, []);
    const kinds = r.fig.series.map((s: any) => s.kind);
    assert.deepEqual(kinds, ['frames', 'hold']);
    const frames = r.fig.series[0];
    assert.deepEqual(frames.x, [1000, 1500, 2000], 'frames are sorted by x');
    const hold = r.fig.series[1];
    assert.equal(hold.x.length, 2);
    assert.ok(hold.lo && hold.hi);
    assert.match(hold.label, /hold median, last 2 s/);
    assert.equal(r.fig.holds.length, 2);
  });
});

// ------------------------------------------------------------------ index and log

describe('buildIndex', () => {
  const fake = (id: string, over: any = {}) => ({
    fig: {id, title: id, finding: 'f', domain: 'PWR', runId: 'r1', chip: 'c', caveats: [{text: 'x', flag: true}, {text: 'y'}]},
    meta: {status: 'publish', order: 1, featured: false, tier: null, product: 'openesc', ...over.meta},
    run: {id: 'r1', date: '2026-01-01', setup: ['s'], chip: 'c', ...over.run},
  });
  it('lists products in config order, only those with figures', () => {
    const {index} = bi([fake('a'), fake('b', {meta: {product: 'openmotor'}})], [], CFG, '2026-01-02');
    assert.deepEqual(index.products.map((p: any) => p.handle), ['openmotor', 'openesc']);
  });
  it('states a run once and rejects a differing setup for the same run', () => {
    const ok = bi([fake('a'), fake('b')], [], CFG, 'x');
    assert.deepEqual(Object.keys(ok.index.runs), ['r1']);
    assert.equal(ok.errors.length, 0);
    const bad = bi([fake('a'), fake('b', {run: {setup: ['other']}})], [], CFG, 'x');
    assert.match(bad.errors.join(), /shared and its setup or chip differs/);
  });
  it('rejects two featured figures for one product and tier', () => {
    const e = bi([fake('a', {meta: {featured: true}}), fake('b', {meta: {featured: true}})], [], CFG, 'x').errors;
    assert.match(e.join(), /2 featured figures/);
  });
  it('counts caveats and flagged caveats', () => {
    const {index} = bi([fake('a')], [], CFG, 'x');
    assert.equal(index.figures.a.caveats, 2);
    assert.equal(index.figures.a.flagged, 1);
  });
});

describe('validateLog', () => {
  const item = (over: any = {}) => ({id: 'a', date: '2026-01-01', product: 'openesc', tested: 't', saw: 's', changed: null, status: 'publish', ...over});
  it('needs a published figure for figureId', () => {
    assert.match(validateLog([item({figureId: 'gone'})], new Set(['x']), CFG).join(), /not a published figure/);
    assert.deepEqual(validateLog([item({figureId: 'x'})], new Set(['x']), CFG), []);
  });
});

// ------------------------------------------------------------------ the CLI

describe('sync-testing CLI against a fake bench app', () => {
  let server: http.Server;
  let api = '';
  const hits: string[] = [];
  let tmp = '';
  let views = '';

  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/api/fields') {
        res.end(JSON.stringify({fields: []}));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const spec = J(body);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer({series: spec.series.map((s: any) => ({id: s.id, points: Array.from({length: 10}, (_, i) => [i * 10, i * 0.2 + 9])}))})));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    api = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  after(() => server.close());

  const write = (name: string, v: any) => fs.writeFileSync(path.join(views, name + '.json'), JSON.stringify(v));
  const run = (args: string[] = ['--write']) =>
    new Promise<{code: number; out: string}>((resolve) => {
      execFile(
        process.execPath,
        [path.join(WEB, 'scripts/sync-testing.mjs'), ...args],
        {
          env: {
            ...process.env,
            TESTING_API: api,
            TESTING_REPO: tmp,
            TESTING_OUT: path.join(tmp, 'out'),
            TESTING_HELD: path.join(tmp, 'held.json'),
            TESTING_LOG: path.join(tmp, 'log.json'),
          },
        },
        (err: any, stdout, stderr) => resolve({code: err ? err.code : 0, out: stdout + stderr}),
      );
    });
  const out = (f: string) => path.join(tmp, 'out', f);
  const indexOf = () => J(fs.readFileSync(out('index.json'), 'utf8'));

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
    views = path.join(tmp, 'Graphs', 'views');
    fs.mkdirSync(views, {recursive: true});
    fs.writeFileSync(path.join(tmp, 'log.json'), JSON.stringify({items: []}));
  });
  after(() => fs.rmSync(tmp, {recursive: true, force: true}));

  it('publishes a view, holds a needs-review view, ignores a view without a block', async () => {
    write('esc-current', view());
    write('esc-held', view({id: 'esc-held'}, {status: 'needs-review', run: 'esc-98-2026-01-01'}));
    write('plain', {id: 'plain', sources: [], series: []});
    const r = await run();
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.existsSync(out('fig/esc-current.json')));
    assert.ok(!fs.existsSync(out('fig/esc-held.json')), 'a held view is never public');
    assert.deepEqual(indexOf().products[0].figures, ['esc-current']);
    const held = J(fs.readFileSync(path.join(tmp, 'held.json'), 'utf8'));
    assert.equal(held.needsReview[0].id, 'esc-held');
  });
  it('only calls the two read-only routes', () => {
    const allowed = new Set(['POST /api/numbers/figure', 'GET /api/fields']);
    assert.ok(hits.length > 0);
    for (const h of hits) assert.ok(allowed.has(h), `unexpected ${h}`);
  });
  it('is in sync with itself under --check', async () => {
    const r = await run(['--check']);
    assert.equal(r.code, 0, r.out);
  });
  it('shows a new published view with no code or config edit', async () => {
    write('esc-two', view({id: 'esc-two'}, {order: 20, featured: false}));
    const r = await run();
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(indexOf().products[0].figures, ['esc-current', 'esc-two']);
  });
  it('removes a figure when its publish block is deleted', async () => {
    const v = view({id: 'esc-two'});
    delete (v as any).publish;
    write('esc-two', v);
    const r = await run();
    assert.equal(r.code, 0, r.out);
    assert.ok(!fs.existsSync(out('fig/esc-two.json')));
    assert.deepEqual(indexOf().products[0].figures, ['esc-current']);
  });
  it('reports drift under --check when a figure file is edited', async () => {
    fs.appendFileSync(out('fig/esc-current.json'), ' ');
    const r = await run(['--check']);
    assert.equal(r.code, 1);
    assert.match(r.out, /DRIFT: fig\/esc-current.json/);
    await run();
  });
  it('treats a draft as unpublished', async () => {
    write('esc-draft', view({id: 'esc-draft'}, {status: 'draft'}));
    const r = await run();
    assert.equal(r.code, 0, r.out);
    assert.ok(!fs.existsSync(out('fig/esc-draft.json')));
    fs.rmSync(path.join(views, 'esc-draft.json'));
  });

  describe('exits non-zero and writes nothing new for', () => {
    const cases: Array<[string, any, any, RegExp]> = [
      ['a banned string in the finding', {}, {finding: 'Reads 10 A, see Private notes.'}, /banned/],
      ['a banned string in a caveat', {}, {caveats: ['Part from siliXcon.']}, /banned/],
      ['a banned string in a series label', {}, {series: {'s1.i': {label: 'OpenFC-Core board'}}}, /banned/],
      ['an empty finding', {}, {finding: ''}, /finding is empty/],
      ['missing by and at', {}, {by: '', at: ''}, /by and at are required/],
      ['an empty setup chip', {}, {setup_chip: ''}, /setup_chip is empty/],
      ['a finding the data does not support', {}, {checks: [{series: 's1.i', stat: 'at', x: 50, xtol: 0.1, min: 20, max: 21}]}, /expected 20 to 21/],
      [
        'a stand series reading current',
        {
          sources: [{id: 's1', ref: 'log:drv-04-thrust-2026-10-10-20261010T132503Z', enabled: true}],
          series: [{id: 's1.i', source: 's1', field: 'i_clamp', name: 'Current', visible: true}],
        },
        {product: 'openmotor', domain: 'THR'},
        /may not export i_clamp/,
      ],
      [
        'stand power in the words',
        {
          sources: [{id: 's1', ref: 'log:drv-04-thrust-2026-10-10-20261010T132503Z', enabled: true}],
          series: [{id: 's1.i', source: 's1', field: 'thrust_g', name: 'Thrust', visible: true}],
        },
        {product: 'openmotor', domain: 'THR', caveats: ['Power draw was not measured.']},
        /current, power or efficiency/,
      ],
      ['a private source ref', {sources: [{id: 's1', ref: 'log:Private/acme/run', enabled: true}]}, {}, /private tree/],
    ];
    for (const [name, viewOver, pubOver, re] of cases) {
      it(name, async () => {
        write('esc-bad', view({id: 'esc-bad', ...viewOver}, pubOver));
        const before = fs.readFileSync(out('index.json'), 'utf8');
        const r = await run();
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, re);
        assert.ok(!fs.existsSync(out('fig/esc-bad.json')), 'the failing view is not written');
        assert.equal(fs.readFileSync(out('index.json'), 'utf8'), before, 'the index is untouched');
        const held = J(fs.readFileSync(path.join(tmp, 'held.json'), 'utf8'));
        assert.equal(held.failed[0].id, 'esc-bad');
        fs.rmSync(path.join(views, 'esc-bad.json'));
      });
    }
    it('a figure over the size budget', async () => {
      write('esc-big', view({id: 'esc-big'}, {featured: false, order: 30, caveats: ['x'.repeat(CFG.figureBudgetKb * 1024)]}));
      const r = await run();
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /over the \d+ KB budget/);
      fs.rmSync(path.join(views, 'esc-big.json'));
    });
  });
});

// ------------------------------------------------------------------ the files on disk

describe('public/testing', () => {
  const dir = path.join(WEB, 'public', 'testing');
  const exists = fs.existsSync(path.join(dir, 'index.json'));
  const index: any = exists ? J(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) : null;
  const ids: string[] = exists ? index.products.flatMap((p: any) => p.figures) : [];
  const figs = new Map<string, any>(ids.map((id) => [id, J(fs.readFileSync(path.join(dir, 'fig', id + '.json'), 'utf8'))]));

  it('has an index and one file per listed figure, and no others', () => {
    assert.ok(exists, 'run npm run sync:testing');
    const files = fs.readdirSync(path.join(dir, 'fig')).map((f) => f.replace(/\.json$/, '')).sort();
    assert.deepEqual(files, [...ids].sort());
    assert.deepEqual(Object.keys(index.figures).sort(), [...ids].sort());
  });
  it('gives every figure a setup chip, a run with a stated setup and a date', () => {
    for (const [id, f] of figs) {
      assert.ok(f.chip && f.chip.length > 8, `${id} chip`);
      const run = index.runs[f.runId];
      assert.ok(run && run.setup.length && /^\d{4}-\d{2}-\d{2}$/.test(run.date), `${id} run`);
      assert.equal(run.chip, f.chip, `${id} chip is the run's chip`);
    }
  });
  it('carries the operator-fixed thrust stand facts in the thrust chip', () => {
    const f = figs.get('openmotor-thrust-vs-rpm');
    assert.ok(f, 'thrust figure published');
    assert.match(f.chip, /1726 g/);
    assert.match(f.chip, /Same OpenMotor-2306/);
    assert.match(f.chip, /two 6S packs/);
    assert.match(f.chip, /ESC reversed/);
    const setup = index.runs[f.runId].setup.join(' ');
    assert.match(setup, /1726 g reference mass/);
    assert.match(setup, /207\.4 counts\/g/);
    assert.match(setup, /same motor on two different 6S packs/);
    assert.match(setup, /reversed so the propeller pulls/);
  });
  it('draws the thrust figure from over 2000 points and its holds as markers with a band', () => {
    const f = figs.get('openmotor-thrust-vs-rpm');
    const frames = f.series.filter((s: any) => s.kind === 'frames');
    const holds = f.series.filter((s: any) => s.kind === 'hold');
    assert.ok(frames.some((s: any) => s.x.length > 2000));
    assert.equal(holds.length, 2);
    for (const h of holds) assert.ok(h.lo && h.hi && h.lo.length === h.x.length);
  });
  it('has the series shape the page reads', () => {
    for (const [id, f] of figs) {
      assert.ok(f.title.split(/\s+/).length >= 3 && f.title.split(/\s+/).length <= 6, `${id} title`);
      assert.ok(f.finding.split(/\s+/).length <= 25, `${id} finding`);
      assert.ok(f.caveats.length > 0 && f.caveats.every((c: any) => typeof c.text === 'string'), `${id} caveats`);
      assert.ok(f.cite && /^Logs\//.test(f.cite), `${id} cite`);
      assert.ok(f.axes.x.label && f.axes.x.unit && f.axes.y.label && f.axes.y.unit, `${id} axes`);
      for (const s of f.series) {
        assert.ok(['trace', 'frames', 'hold'].includes(s.kind), `${id}/${s.id} kind`);
        assert.ok(['current', 'voltage', 'temperature', 'rpm', 'command', 'aux', 'thrust'].includes(s.quantity), `${id}/${s.id} quantity`);
        assert.equal(s.x.length, s.y.length);
        assert.ok(s.x.length <= 2500, `${id}/${s.id} points`);
        for (let i = 1; i < s.x.length; i++) assert.ok(s.x[i]! >= s.x[i - 1]!, `${id}/${s.id} x ascending`);
        if (s.lo) assert.equal(s.lo.length, s.x.length);
        if (s.hi) assert.equal(s.hi.length, s.x.length);
      }
    }
  });
  it('keeps every figure under the size budget', () => {
    for (const id of ids) {
      const bytes = fs.statSync(path.join(dir, 'fig', id + '.json')).size;
      assert.ok(bytes <= CFG.figureBudgetKb * 1024, `${id} is ${bytes} bytes`);
    }
  });
  it('never exports current, power or g per W for a stand run', () => {
    const stand = new Set(ids.filter((id) => figs.get(id).runId.startsWith('drv-04-')));
    assert.ok(stand.size > 0);
    for (const id of stand) {
      const text = JSON.stringify(figs.get(id)) + JSON.stringify(index.runs[figs.get(id).runId]);
      assert.doesNotMatch(text, /\b(current|power|efficiency)\b|g\/W/i, id);
      assert.doesNotMatch(JSON.stringify(figs.get(id).axes), /"unit":"(A|W)"/, id);
    }
  });
  it('has no banned string anywhere', () => {
    for (const name of ['index.json', ...ids.map((id) => `fig/${id}.json`)]) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const [re, why] of CFG.bannedRe) assert.doesNotMatch(text, re, `${name}: ${why}`);
    }
  });
  it('lists the log entries against published figures only', () => {
    for (const t of index.log) {
      if (t.figureId) assert.ok(ids.includes(t.figureId), `${t.id} -> ${t.figureId}`);
      assert.equal(t.status, undefined);
    }
  });
});
