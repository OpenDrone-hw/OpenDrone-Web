import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {directInstallEnabled} from './flasher/direct-install.ts';
import {CHIP_PACKAGE_VERIFIED, PICOBOOT_WRITE_VERIFIED} from './flasher/targets.ts';
import {findFamily, resolveGuidePage, type GuidePage} from './guides.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** Every reader-visible string of a page. */
function visible(p: GuidePage): string {
  return [
    ...p.intro,
    ...p.callouts.flatMap((c) => [c.title, c.text]),
    ...p.steps.flatMap((s) => [s.title, s.text, s.see ?? '', s.code ?? '']),
    ...(p.sections ?? []).flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.bullets ?? [])]),
    ...p.troubleshooting.flatMap((t) => [t.problem, t.fix]),
  ].join('\n');
}

const OFF_ONLY = /switched off|not published|Direct install is switched off|it is the supported way|cannot find an install button/i;
const ON_ONLY = /one button|one click|RP2350 Boot|Click \*\*Continue\*\*/i;

const openfc = findFamily('flash-openfc')!;
const page = (slug: string) => openfc.pages.find((p) => p.slug === slug)!;

test('one gate: staging bench, both hardware-verify flags, or per-board evidence (the OpenFC-Lite only)', () => {
  assert.equal(directInstallEnabled(true), true);
  assert.equal(CHIP_PACKAGE_VERIFIED || PICOBOOT_WRITE_VERIFIED, false, 'the global flags stay false');
  assert.equal(directInstallEnabled(false), true, 'the OpenFC-Lite pin is bench-verified');
  assert.equal(directInstallEnabled(false, 'OPENFC_LITE_RP2350B'), true);
  assert.equal(directInstallEnabled(false, 'OPENFC_LITE_MINI_RP2350A'), false);
});

test('production (Lite verified): the guides describe the one-button install for the Lite and say the Mini comes later', () => {
  const on = directInstallEnabled(false);
  const install = visible(resolveGuidePage(page('flash'), on));
  assert.match(install, /one button/);
  assert.match(install, /works for the OpenFC-Lite\. The Lite Mini file comes later\./);
  const recovery = visible(resolveGuidePage(page('recovery'), on));
  assert.match(recovery, /has the OpenFC-Lite file/);
  assert.match(recovery, /For the Lite Mini it still shows "firmware not published yet"/);
});

test('gate on (staging bench): the guides describe the one-button install and never "switched off"', () => {
  const on = directInstallEnabled(true);
  for (const slug of ['boot-mode', 'flash', 'verify']) {
    assert.doesNotMatch(visible(resolveGuidePage(page(slug), on)), OFF_ONLY, slug);
  }
  const install = visible(resolveGuidePage(page('flash'), on));
  assert.match(install, /one button/);
  assert.match(install, /\*\*Update firmware\*\*/);
  assert.match(install, /\*\*RP2350 Boot\*\*/);
  assert.match(install, /resets the board's settings/);
  assert.ok(install.indexOf('Update firmware') < install.indexOf('drag the `.uf2`'), 'one button first, drag and drop as the fallback');
  assert.match(visible(resolveGuidePage(page('boot-mode'), on)), /usually you can skip this page/);
});

test('gate off (base pages): no one-button claim anywhere in the OpenFC guide', () => {
  const off = false;
  for (const p of openfc.pages) {
    const v = visible(resolveGuidePage(p, off));
    assert.doesNotMatch(v, ON_ONLY, p.slug);
    assert.equal(resolveGuidePage(p, off), p, 'base page unchanged');
  }
});

test('the /guides index entry and the OpenFC list follow the same gate', () => {
  assert.equal(openfc.tool?.href, '/guides/flash');
  assert.equal(openfc.tool!.directTitle, 'Update firmware with one button');
  assert.doesNotMatch(openfc.tool!.title, ON_ONLY);
  const copy = JSON.parse(read('../../content/copy/guides.json')) as Record<string, string>;
  assert.match(copy.flash_cta_note_direct, /In Chrome or Edge, .* one button: Update firmware\./);
  assert.match(copy.flash_cta_note_direct, /fallback/);
  assert.doesNotMatch(copy.flash_cta_note, ON_ONLY);
  const index = read('../routes/guides._index.tsx');
  assert.match(index, /const direct = useDirectInstallEnabled\(\);/);
  assert.match(index, /id=\{direct \? 'guides\.flash_cta_note_direct' : 'guides\.flash_cta_note'\}/);
  assert.match(index, /\{direct \? family\.tool\.directTitle : family\.tool\.title\}/);
  assert.ok(index.indexOf('family.tool ?') < index.indexOf('family.pages.map'), 'tool link listed first');
});

test('the guide pages, the index and the flasher read the gate from the same helper', () => {
  assert.match(read('../routes/guides.$family.$step.tsx'), /const page = resolveGuidePage\(basePage, useDirectInstallEnabled\(\)\);/);
  assert.match(read('./flasher/ui/use-direct-install.ts'), /return directInstallEnabled\(useStagingBench\(\)\);/);
  const fc = read('./flasher/ui/FcFlasher.tsx');
  assert.match(fc, /const writesOn = directInstallEnabled\(staging\);/);
  assert.doesNotMatch(fc, /CHIP_PACKAGE_VERIFIED && PICOBOOT_WRITE_VERIFIED/, 'no second copy of the expression');
});

test('guide pages reuse the firmware page\'s dark code chip (no light-on-light code)', () => {
  const css = read('../styles/app.css');
  assert.match(css, /\.flash-page code,\s*\.guide-page code \{\s*background: color-mix\(in srgb, var\(--color-text\) 10%, var\(--color-bg-card\)\);\s*color: var\(--color-text\);/);
  assert.match(css, /\.guide-page pre code \{\s*background: none;/);
  assert.match(read('../routes/guides.$family.$step.tsx'), /<article className="page-shell guide-page">/);
  assert.match(read('../routes/guides._index.tsx'), /<article className="page-shell guide-page">/);
});
