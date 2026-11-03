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

test('one gate: staging bench, or both hardware-verify flags', () => {
  assert.equal(directInstallEnabled(true), true);
  assert.equal(directInstallEnabled(false), CHIP_PACKAGE_VERIFIED && PICOBOOT_WRITE_VERIFIED);
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

test('gate off (production): no one-button claim anywhere in the OpenFC guide', () => {
  const off = false;
  assert.equal(directInstallEnabled(off), false, 'the verify flags are still false');
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

const CHECKLIST = [
  /Back up your config: save `diff all`, because flashing resets settings\./,
  /Props off, battery out, USB only\./,
  /Computer only \(Chrome\/Edge\), with a data-capable USB cable\./,
  /Test on USB before soldering\./,
];

test('firmware page: numbered 4-item pre-flash checklist directly above Update firmware', () => {
  const fc = read('./flasher/ui/FcFlasher.tsx');
  const ol = /<ol className="flash-checklist">([\s\S]*?)<\/ol>/.exec(fc);
  assert.ok(ol, 'checklist is an <ol>');
  const items = ol[1].replace(/<code>(.*?)<\/code>/g, '`$1`').replace(/\s+/g, ' ');
  assert.equal(ol[1].match(/<li>/g)?.length, 4);
  let at = -1;
  for (const re of CHECKLIST) {
    const m = re.exec(items);
    assert.ok(m, String(re));
    assert.ok(m.index > at, 'in order');
    at = m.index;
  }
  const olEnd = fc.indexOf('</ol>');
  const btn = fc.indexOf('Update firmware', olEnd);
  assert.ok(btn > olEnd);
  const between = fc.slice(olEnd, btn);
  assert.match(between, /<button/);
  assert.doesNotMatch(between, /<p|<h\d|<details|<div/, 'nothing but the backup checkbox between checklist and button');
  const css = read('../styles/app.css');
  const rule = /\.flash-checklist \{([^}]*)\}/.exec(css)![1];
  assert.match(rule, /list-style: decimal/);
  assert.match(rule, /border-left: 2px solid var\(--color-accent\)/);
});

test('backup checkbox gates only the disabled state; the click handler still starts with startUpdate', () => {
  const fc = read('./flasher/ui/FcFlasher.tsx');
  assert.match(fc, /<label htmlFor=\{backupId\}[\s\S]*?<input id=\{backupId\} type="checkbox"[\s\S]*?I&apos;ve backed up my config\s*<\/label>/);
  // Locked or not backed up: aria-disabled (still focusable), described by the visible reason; never the disabled attribute.
  assert.match(fc, /aria-disabled=\{locked \|\| needsBackup \|\| undefined\}\s+aria-describedby=\{needsBackup \? backupReasonId : lockText \? lockReasonId : locked \? statusId : undefined\}/);
  assert.doesNotMatch(fc, /disabled=\{!canRun/);
  assert.match(fc, /<p id=\{lockReasonId\} className="flash-note">\s+\{lockText\}/);
  assert.match(fc, /onClick=\{\(\) => \(board \? void save\(\) : say\(PICK_BOARD_TEXT\)\)\}\s+aria-disabled=\{!board \|\| undefined\}\s+aria-describedby=\{board \? undefined : pickBoardId\}/);
  assert.match(fc, /flag: published\(t\) \? undefined : 'Not published yet'/);
  assert.match(fc, /<p id=\{backupReasonId\} className="flash-note">\s+\{BACKUP_REASON\}/);
  assert.match(fc, /const BACKUP_REASON = 'Confirm your config backup first\.';/);
  assert.match(fc, /onClick=\{onUpdate\}/);
  // The decision itself is tested behaviourally in flasher/ui/update-click.test.ts.
  const onUpdate = /const onUpdate = \(\) => \{([\s\S]*?)\n {2}\};/.exec(fc)![1];
  assert.doesNotMatch(onUpdate, /await|async/, 'no await before the serial picker');
  assert.match(onUpdate, /^\s*const flow = updateClick\(\{locked, backedUp, lockText, backupReason: BACKUP_REASON\}, say, deps\);/);
});

test('firmware page: one line for the second device picker, at the Continue step', () => {
  const fc = read('./flasher/ui/FcFlasher.tsx');
  const needUsb = /\{run\.kind === 'need-usb' \? \(([\s\S]*?)\) : null\}/.exec(fc)![1];
  assert.match(needUsb, /Your browser asks a second time: click Continue, then pick RP2350 Boot\./);
  assert.ok(needUsb.indexOf('second time') < needUsb.indexOf('onClick={resume}'));
});

test('firmware page: version + short SHA next to the offered file, via firmwareIdText', () => {
  const fc = read('./flasher/ui/FcFlasher.tsx');
  assert.match(fc, /\{short\(t\)\}: \{firmwareIdText\(r\)\}/, 'under Update firmware (install)');
  assert.match(fc, /\{boardRelease \? <span className="flash-filename">\{firmwareIdText\(boardRelease\)\}<\/span> : null\}/, 'under Save (download)');
  assert.ok(fc.indexOf('firmwareIdText(boardRelease)') > fc.indexOf('Save firmware (.uf2)'));
});

test('guide flash step (base and one-button) carries the same 4 checklist items', () => {
  for (const on of [false, true]) {
    const p = resolveGuidePage(page('flash'), on);
    const c = p.callouts.find((x) => x.title === 'Before you flash');
    assert.ok(c, `callout present (direct=${on})`);
    let at = -1;
    for (const [i, re] of CHECKLIST.entries()) {
      const m = new RegExp(`${i + 1}\. ${re.source}`).exec(c.text);
      assert.ok(m, `${re} (direct=${on})`);
      assert.ok(m.index > at);
      at = m.index;
    }
  }
});

test('one live region for the flasher status; the file input reflows at 320px', () => {
  const fc = read('./flasher/ui/FcFlasher.tsx');
  assert.doesNotMatch(fc, /aria-live/, 'FcFlasher announces through say() only');
  assert.match(read('../routes/guides.flash.tsx'), /<div aria-live="polite" aria-atomic="true" className="sr-only">/);
  assert.doesNotMatch(fc, /say\(`\$\{r\.text\} \$\{BOOT_HINT\}`\)/, 'failures are announced by role="alert" only');
  assert.match(fc, /type="file"[^>]*className="mt-2 block w-full max-w-full"/);
});
