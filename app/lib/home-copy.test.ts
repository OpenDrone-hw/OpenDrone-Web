import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const home = JSON.parse(read('../../content/copy/home.json')) as Record<string, string>;

test('the 5-inch scene names the OpenESC-30x30 rating: 60 A per motor', () => {
  const studio = read('../../public/models/od5/studio.json');
  assert.match(studio, /"note": "4in1, AM32, 60A per motor"/);
  const esc = read('../../content/products/openesc.json');
  assert.match(esc, /"subtitle": "4in1, AM32, 60A, 2-8S, 30x30"/, 'source of the figure');
  assert.match(read('../../public/models/od3/studio.json'), /"note": "4in1, AM32, 40A"/, '3-inch (20x20) unchanged');
});

test('the phone tagline says the motors are OEM', () => {
  assert.match(home.m_tagline, /Motors are OEM, not open hardware\.$/);
});

test('the build card shows "parts, not a drone" in words taken from build_help', () => {
  assert.match(home.build_note, /^Parts, not a ready-to-fly drone\./);
  const rest = home.build_note.replace(/^Parts, not a ready-to-fly drone\. /, '');
  assert.ok(home.build_help.includes(rest), 'second sentence is verbatim from build_help');
  assert.match(read('../components/HeroBuildGuide.tsx'), /<Txt id="home\.build_note" as="p" className="hero-build-ship" \/>/);
});
