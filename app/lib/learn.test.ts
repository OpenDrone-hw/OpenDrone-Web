import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {
  claimCount,
  dossierMeta,
  isCircular,
  LEARN_DOSSIERS,
  learnDraftEnabled,
  parseClaim,
  parseDossier,
  slugifyHeading,
  sourceLabel,
} from './learn.ts';

// ---- claim parsing -------------------------------------------------------

test('lifts a trailing Source block and confidence tag out of the claim', () => {
  const c = parseClaim(
    'The 8 to 144 kHz range is a v2.19 feature. Source: https://github.com/am32-firmware/AM32/releases/tag/v2.19 [verified]',
  );
  assert.equal(c.text, 'The 8 to 144 kHz range is a v2.19 feature.');
  assert.deepEqual(c.sources, [
    'https://github.com/am32-firmware/AM32/releases/tag/v2.19',
  ]);
  assert.equal(c.confidence, 'verified');
  assert.equal(c.note, '');
});

test('keeps the tag qualifier', () => {
  const c = parseClaim('Something. Source: https://example.com/a [verified, primary]');
  assert.equal(c.confidence, 'verified');
  assert.equal(c.note, 'primary');
});

test('collects several sources and dedupes them', () => {
  const c = parseClaim(
    'Claim. Source: https://a.example/x , https://b.example/y , https://a.example/x [verified]',
  );
  assert.deepEqual(c.sources, ['https://a.example/x', 'https://b.example/y']);
});

test('an inline tag mid-bullet still classifies the claim', () => {
  const c = parseClaim(
    'In Europe the 35 MHz band is aircraft-only by rule (BMFA Handbook via search snippet) [single]',
  );
  assert.equal(c.confidence, 'single');
  assert.match(c.text, /^In Europe the 35 MHz band/);
  assert.match(c.text, /BMFA Handbook/);
});

test('an untagged bullet is marked untagged, not silently verified', () => {
  const c = parseClaim('Coverage note: this section is thin.');
  assert.equal(c.confidence, 'untagged');
  assert.deepEqual(c.sources, []);
});

test('a lifted URL does not leave an empty parenthesis behind', () => {
  const c = parseClaim('Claim text. Source: (https://example.com/a) [verified]');
  assert.equal(c.text, 'Claim text.');
});

test('the last tag wins when a bullet carries more than one', () => {
  const c = parseClaim('A [verified] then B. Source: https://x.example [single]');
  assert.equal(c.confidence, 'single');
});

// ---- circularity ---------------------------------------------------------

test('an OpenBrain-sourced claim is circular', () => {
  const c = parseClaim(
    'Practical band on a 5 inch quad is 30 to 55 kHz. Source: openbrain `facts`, `faq/esc/am32` [single]',
  );
  assert.equal(isCircular(c), true);
});

test('a claim with a real URL is not circular even if it mentions openbrain', () => {
  const c = parseClaim(
    'OpenBrain reads this corpus. Source: https://example.com/a [verified]',
  );
  assert.equal(isCircular(c), false);
});

// ---- document parsing ----------------------------------------------------

const SAMPLE = `# Test Dossier

Intro paragraph explaining the method.

---

## Rung 1

Some prose under the heading.

- First claim. Source: https://example.com/one [verified]
- Second claim spanning
  two source lines, joined. Source: https://example.com/two [single]

### Sub-rung

- Third claim. Source: openbrain \`facts\` [single]
`;

test('parses headings, intro, prose and claims into one dossier', () => {
  const d = parseDossier('loop-ladder', SAMPLE);
  assert.equal(d.title, 'Test Dossier');
  assert.deepEqual(d.intro, ['Intro paragraph explaining the method.']);
  assert.equal(d.sections.length, 2);
  assert.equal(d.sections[0].heading, 'Rung 1');
  assert.equal(d.sections[0].level, 2);
  assert.deepEqual(d.sections[0].blocks, [
    {kind: 'prose', text: 'Some prose under the heading.'},
  ]);
  assert.equal(d.sections[0].claims.length, 2);
  assert.equal(d.sections[1].level, 3);
  assert.equal(claimCount(d), 3);
});

test('claims carry a stable per-section anchor id', () => {
  const d = parseDossier('loop-ladder', SAMPLE);
  assert.deepEqual(
    d.sections[0].claims.map((c) => c.id),
    ['rung-1-1', 'rung-1-2'],
  );
  assert.equal(d.sections[1].claims[0].id, 'sub-rung-1');
});

test('a wrapped bullet is joined into one claim, not split into two', () => {
  const d = parseDossier('loop-ladder', SAMPLE);
  assert.equal(
    d.sections[0].claims[1].text,
    'Second claim spanning two source lines, joined.',
  );
});

test('counts and circular tally match the parsed claims', () => {
  const d = parseDossier('loop-ladder', SAMPLE);
  assert.equal(d.counts.verified, 1);
  assert.equal(d.counts.single, 2);
  assert.equal(d.circular, 1);
});

test('headings become stable anchor ids', () => {
  assert.equal(slugifyHeading('Rung 1: MOSFET switching / PWM carrier'), 'rung-1-mosfet-switching-pwm-carrier');
  assert.equal(slugifyHeading('***'), 'section');
});

test('source labels show the host', () => {
  assert.equal(sourceLabel('https://www.github.com/a/b'), 'github.com');
  assert.equal(sourceLabel('not a url'), 'not a url');
});

test('a markdown table becomes a table block, not mangled prose', () => {
  const d = parseDossier(
    'loop-ladder',
    [
      '# T',
      '',
      '## Ladder',
      '',
      '| Rung | Rate |',
      '|---|---|',
      '| ESC PWM | 24 kHz |',
      '| PID loop | 8 kHz |',
      '',
      '- A claim. Source: https://example.com/a [verified]',
    ].join('\n'),
  );
  const block = d.sections[0].blocks[0];
  assert.equal(block.kind, 'table');
  assert.deepEqual(block.kind === 'table' ? block.head : [], ['Rung', 'Rate']);
  assert.deepEqual(block.kind === 'table' ? block.rows : [], [
    ['ESC PWM', '24 kHz'],
    ['PID loop', '8 kHz'],
  ]);
  assert.equal(d.sections[0].claims.length, 1);
});

test('pipes without a separator row stay prose', () => {
  const d = parseDossier(
    'loop-ladder',
    ['# T', '', '## S', '', '| not | a table |', ''].join('\n'),
  );
  assert.equal(d.sections[0].blocks[0].kind, 'prose');
});

// ---- the draft gate ------------------------------------------------------

test('the draft gate is closed unless the flag is set', () => {
  assert.equal(learnDraftEnabled(undefined), false);
  assert.equal(learnDraftEnabled({}), false);
  assert.equal(learnDraftEnabled({PUBLIC_LEARN_DRAFT: '0'}), false);
  assert.equal(learnDraftEnabled({PUBLIC_LEARN_DRAFT: 'true'}), false);
  assert.equal(learnDraftEnabled({PUBLIC_LEARN_DRAFT: '1'}), true);
});

// ---- the corpus on disk --------------------------------------------------

test('every listed dossier has a file, and it parses to claims', () => {
  for (const m of LEARN_DOSSIERS) {
    const src = readFileSync(
      new URL(`../content/learn/${m.slug}.md`, import.meta.url),
      'utf8',
    );
    const d = parseDossier(m.slug, src);
    assert.ok(claimCount(d) > 50, `${m.slug} parsed only ${claimCount(d)} claims`);
    assert.ok(d.sections.length > 5, `${m.slug} parsed ${d.sections.length} sections`);
    assert.equal(dossierMeta(m.slug)?.title, m.title);
  }
});

test('the corpus carries no local filesystem paths', () => {
  for (const m of LEARN_DOSSIERS) {
    const src = readFileSync(
      new URL(`../content/learn/${m.slug}.md`, import.meta.url),
      'utf8',
    );
    // Anchored on a path boundary so `api.github.com/users/<login>` - a real
    // citation in the ESC dossier - does not read as a home directory.
    assert.ok(
      !/(?:^|[\s`("'])\/Users\//m.test(src) && !/\/private\/tmp/.test(src),
      `${m.slug} still cites a path from someone's machine`,
    );
  }
});
