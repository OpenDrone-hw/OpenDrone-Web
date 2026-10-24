import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';

// Invariants of the exploded-view hero assets (public/models/od*/): what the
// scene loads must agree with itself, or a part silently never moves, a beat
// focuses nothing, or a hover label reads blank.
const root = join(process.cwd(), 'public/models');
const designs = readdirSync(root).filter((d) => /^od\d+$/.test(d));

type Move = {v: number[]; t: number; dur: number};
type Unit = {id: string; label: string; kind: string; chunk: string; moves: Move[]};

function glbNodeNames(file: string): Set<string> {
  const b = readFileSync(file);
  assert.equal(b.toString('latin1', 0, 4), 'glTF', `${file} is not a GLB`);
  const len = b.readUInt32LE(12);
  const json = JSON.parse(b.toString('utf8', 20, 20 + len));
  return new Set((json.nodes ?? []).map((n: {name?: string}) => n.name ?? ''));
}

test('there is at least one exploded design', () => {
  assert.ok(designs.length >= 2, 'od3 and od5 are expected');
});

for (const design of designs) {
  const dir = join(root, design);
  const ex = JSON.parse(readFileSync(join(dir, 'explode.json'), 'utf8')) as {
    units: Unit[];
    groups: Record<string, string[]>;
  };
  const studio = JSON.parse(readFileSync(join(dir, 'studio.json'), 'utf8')) as {
    beats: Array<{id: string; select?: {group?: string; none?: boolean}}>;
  };
  const chunks = (JSON.parse(readFileSync(join(dir, 'chunks.json'), 'utf8')) as {
    chunks: Array<{id: string; file: string; bytes: number}>;
  }).chunks;

  test(`${design}: every unit has a label, finite timed moves inside 0..1`, () => {
    const ids = new Set<string>();
    for (const u of ex.units) {
      assert.ok(!ids.has(u.id), `duplicate unit ${u.id}`);
      ids.add(u.id);
      assert.ok(u.label.trim().length > 2, `${u.id} has no label`);
      assert.ok(!/[\u2013\u2014]/.test(u.label), `${u.id} label has a dash glyph`);
      assert.ok(u.moves.length >= 1, `${u.id} never moves`);
      for (const m of u.moves) {
        assert.ok(m.v.length === 3 && m.v.every(Number.isFinite), `${u.id} move vector`);
        assert.ok(m.t >= 0 && m.dur > 0 && m.t + m.dur <= 1.0001, `${u.id} timing ${m.t}+${m.dur}`);
      }
    }
  });

  test(`${design}: every unit exists as a node in its chunk`, () => {
    const byChunk = new Map(chunks.map((c) => [c.id, glbNodeNames(join(dir, c.file))]));
    for (const u of ex.units) {
      const names = byChunk.get(u.chunk);
      assert.ok(names, `${u.id}: unknown chunk ${u.chunk}`);
      assert.ok(names.has(u.id), `${u.id} missing from ${u.chunk}`);
    }
  });

  test(`${design}: chunk sizes match the manifest`, () => {
    for (const c of chunks) assert.equal(statSync(join(dir, c.file)).size, c.bytes, c.file);
  });

  test(`${design}: beats select groups that exist and hold parts`, () => {
    const ids = new Set(ex.units.map((u) => u.id));
    for (const b of studio.beats) {
      if (b.select?.none) continue;
      const g = b.select?.group;
      assert.ok(g && ex.groups[g]?.length, `beat ${b.id} selects an empty group`);
      for (const id of ex.groups[g]) assert.ok(ids.has(id), `group ${g}: unknown unit ${id}`);
    }
  });

  test(`${design}: every screw ends up moved off its start`, () => {
    for (const u of ex.units.filter((x) => x.kind === 'screw')) {
      const total = u.moves.reduce((s, m) => s + Math.hypot(...m.v), 0);
      assert.ok(total > 0.002, `${u.id} stays in its hole`);
    }
  });
}
