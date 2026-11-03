import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  buildHowToJsonLd,
  ESC_COMING_STATUS,
  findFamily,
  findGuide,
  GUIDE_FAMILIES,
  guidePaths,
  jsonLd,
  plainText,
} from './guides.ts';
import type {Callout, GuidePage} from './guides.ts';

const ALL_PAGES = GUIDE_FAMILIES.flatMap((f) => f.pages.map((p) => ({f, p})));

/** Every string a page renders, for content-wide checks. */
function strings(): string[] {
  return ALL_PAGES.flatMap(({p}) => [
    p.title,
    p.description,
    ...p.intro,
    ...p.tools,
    ...p.callouts.flatMap((c) => [c.title, c.text]),
    ...p.steps.flatMap((s) => [s.title, s.text, s.see ?? '', s.code ?? '']),
    ...(p.sections ?? []).flatMap((s) => [
      s.heading,
      ...(s.paragraphs ?? []),
      ...(s.bullets ?? []),
      s.code ?? '',
    ]),
    ...p.troubleshooting.flatMap((t) => [t.problem, t.fix]),
  ]);
}

test('every guide path is unique and starts with /guides', () => {
  const paths = guidePaths();
  assert.equal(new Set(paths).size, paths.length);
  for (const p of paths) assert.match(p, /^\/guides(\/[a-z0-9-]+\/[a-z0-9-]+)?$/);
  assert.equal(paths.length, 1 + ALL_PAGES.length);
});

test('each family has four steps with prev/next forming one chain', () => {
  for (const f of GUIDE_FAMILIES) {
    assert.equal(f.pages.length, 4, f.id);
    assert.equal(findFamily(f.id), f);
    f.pages.forEach((p, i) => {
      const loc = findGuide(f.id, p.slug);
      assert.ok(loc);
      assert.equal(loc.index, i);
      assert.equal(loc.prev?.slug ?? null, f.pages[i - 1]?.slug ?? null);
      assert.equal(loc.next?.slug ?? null, f.pages[i + 1]?.slug ?? null);
    });
  }
  assert.equal(findGuide('flash-openfc', 'nope'), null);
  assert.equal(findGuide('nope', 'flash'), null);
});

test('every page has steps, a safety callout and troubleshooting', () => {
  for (const {f, p} of ALL_PAGES) {
    const where = `${f.id}/${p.slug}`;
    assert.ok(p.steps.length >= 3, where);
    assert.ok(p.troubleshooting.length >= 2, where);
    assert.ok(p.callouts.some((c) => c.kind === 'safety'), where);
    assert.ok(p.tools.length > 0, where);
  }
});

test('meta descriptions fit a search snippet and titles are unique', () => {
  for (const {p} of ALL_PAGES) {
    assert.ok(p.description.length >= 70 && p.description.length <= 160, `${p.title}: ${p.description.length}`);
  }
  const titles = ALL_PAGES.map(({p}) => p.title);
  assert.equal(new Set(titles).size, titles.length);
});

test('internal links point at real routes', () => {
  const known = new Set([...guidePaths(), '/guides/flash', '/support']);
  for (const s of strings()) {
    for (const m of s.matchAll(/\]\((\/[^)\s#]*)/g)) {
      assert.ok(known.has(m[1]), `unknown internal link ${m[1]} in: ${s.slice(0, 60)}`);
    }
  }
});

test('the OpenFC guides name both Betaflight targets', () => {
  const text = strings().join('\n');
  assert.match(text, /OPENFC_LITE_RP2350B/);
  assert.match(text, /OPENFC_LITE_MINI_RP2350A/);
});

test('the Linux udev rule matches the RP2350 bootloader USB id', () => {
  const text = strings().join('\n');
  assert.match(text, /ATTRS\{idVendor\}=="2e8a", ATTRS\{idProduct\}=="000f"/);
});

test('plainText strips links, emphasis and code', () => {
  assert.equal(
    plainText('Open [the page](/flash), type `version`, **then** *save*.'),
    'Open the page, type version, then save.',
  );
});

test('HowTo JSON-LD mirrors the visible steps', () => {
  const loc = findGuide('flash-openfc', 'flash');
  assert.ok(loc);
  const ld = buildHowToJsonLd(loc, 'https://opendrone.be');
  assert.equal(ld['@type'], 'HowTo');
  assert.equal(ld.url, 'https://opendrone.be/guides/flash-openfc/flash');
  assert.equal(ld.step.length, loc.page.steps.length);
  assert.equal(ld.step[0].url, 'https://opendrone.be/guides/flash-openfc/flash#step-1');
  for (const s of ld.step) assert.doesNotMatch(s.text, /\]\(|`|\*\*/);
});

test('jsonLd cannot close the script element', () => {
  const out = jsonLd({x: '</script><script>alert(1)</script>'});
  assert.doesNotMatch(out, /</);
  assert.deepEqual(JSON.parse(out), {x: '</script><script>alert(1)</script>'});
});

test('ESC pages that mention installing carry the "coming after bench verification" status', () => {
  const esc = findFamily('flash-openesc');
  assert.ok(esc);
  for (const slug of ['flash', 'recovery']) {
    const page: GuidePage | undefined = esc.pages.find((p: GuidePage) => p.slug === slug);
    assert.ok(page);
    assert.ok(page.callouts.some((c: Callout) => c.title === ESC_COMING_STATUS), slug);
    assert.equal(page.howTo, false, `${slug}: no HowTo for steps that cannot be done yet`);
  }
  const flash = esc.pages.find((p) => p.slug === 'flash');
  assert.ok(flash);
  assert.match(flash.description, /coming after bench verification/i);
});

test('ESC guides never tell a beginner to flash with our tool or a third-party file', () => {
  const esc = findFamily('flash-openesc');
  assert.ok(esc);
  const steps = esc.pages.flatMap((p) => p.steps.map((s) => `${s.title} ${s.text}`));
  for (const t of steps) {
    assert.doesNotMatch(t, /click the button to flash|Flash All|Select file|use a file from your computer/i, t);
  }
});

test('FC install guide: the Lite Mini file is not published yet, direct install is OpenFC-Lite only, never "switched off"', () => {
  const loc = findGuide('flash-openfc', 'flash');
  assert.ok(loc);
  assert.ok(loc.page.callouts.some((c) => /not published yet/i.test(c.title)));
  assert.ok(loc.page.sections?.some((s) => /OpenFC-Lite only/i.test(s.heading)));
  assert.doesNotMatch(JSON.stringify(loc.page), /switched off/i);
  assert.doesNotMatch(JSON.stringify(buildHowToJsonLd(loc, 'https://opendrone.be')), /switched off/i);
  for (const slug of ['boot-mode', 'recovery']) assert.doesNotMatch(JSON.stringify(findGuide('flash-openfc', slug)?.page), /switched off/i, slug);
  assert.ok(findGuide('flash-openfc', 'recovery')?.page.callouts.some((c) => /not published yet/i.test(c.title)));
});

test('HowTo JSON-LD is kept for the actionable FC pages', () => {
  for (const slug of ['boot-mode', 'flash', 'verify', 'recovery']) {
    assert.notEqual(findGuide('flash-openfc', slug)?.page.howTo, false, slug);
  }
});

test('F5/F6: ESC pages tell the reader how to leave passthrough and never promise a version on /flash', () => {
  for (const slug of ['connect', 'verify', 'recovery']) {
    const page = findGuide('flash-openesc', slug)?.page;
    assert.ok(page, slug);
    assert.ok(page.troubleshooting.some((t) => /power-cycle the flight controller to leave passthrough/i.test(t.fix)), slug);
  }
  const connect = findGuide('flash-openesc', 'connect')?.page;
  assert.ok(connect?.steps.some((s) => /Disconnect/.test(s.title)));
  const recovery = findGuide('flash-openesc', 'recovery')?.page;
  assert.ok(recovery?.troubleshooting.every((t) => !/Flash the others/i.test(t.fix)));
});
