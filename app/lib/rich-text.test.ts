import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {isPlain, parseRich} from './rich-text.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/rich-text.test.ts

describe('parseRich', () => {
  it('leaves plain text alone', () => {
    assert.deepEqual(parseRich('Just words.'), [{t: 'text', v: 'Just words.'}]);
  });

  it('splits an internal link out of a sentence', () => {
    assert.deepEqual(parseRich('see the [production page](/production) for more'), [
      {t: 'text', v: 'see the '},
      {t: 'link', v: 'production page', href: '/production', external: false},
      {t: 'text', v: ' for more'},
    ]);
  });

  it('marks an http link external', () => {
    const [node] = parseRich('[Discord](https://discord.gg/x)');
    assert.deepEqual(node, {
      t: 'link',
      v: 'Discord',
      href: 'https://discord.gg/x',
      external: true,
    });
  });

  it('handles emphasis', () => {
    assert.deepEqual(parseRich('a flight controller *is mostly* an IMU'), [
      {t: 'text', v: 'a flight controller '},
      {t: 'em', v: 'is mostly'},
      {t: 'text', v: ' an IMU'},
    ]);
  });

  it('handles several tokens in one string', () => {
    const out = parseRich('[a](/a) and *b* and [c](https://c.example)');
    assert.equal(out.filter((n) => n.t === 'link').length, 2);
    assert.equal(out.filter((n) => n.t === 'em').length, 1);
  });

  it('is reusable: a shared regex must not leak lastIndex between calls', () => {
    // The token regex is module-level and /g. Without an explicit lastIndex
    // reset, the second call would start mid-string and silently drop a link.
    const s = 'go [here](/here) now';
    assert.deepEqual(parseRich(s), parseRich(s));
    assert.equal(parseRich(s).filter((n) => n.t === 'link').length, 1);
  });
});

describe('parseRich href safety', () => {
  // Values come from a repo file rather than a visitor, so this is not an XSS
  // boundary. It is still not a reason to render an active javascript: URL.
  const blocked = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example/path',
    'file:///etc/passwd',
  ];

  for (const href of blocked) {
    it(`refuses ${href.slice(0, 28)} and degrades to plain text`, () => {
      const out = parseRich(`[click](${href})`);
      // The property that matters: no clickable node is ever produced.
      assert.ok(
        !out.some((n) => n.t === 'link'),
        `${href} produced a link`,
      );
      // Degrades to the label rather than vanishing, so a typo is visible in
      // the page instead of silently deleting a sentence. Some of these leave a
      // stray character behind (an href containing `(` ends the match early, so
      // the trailing `)` falls through as text) - ugly authoring output, but
      // inert, which is the point.
      const text = out.map((n) => n.v).join('');
      assert.ok(text.startsWith('click'), `lost the label: ${text}`);
      assert.ok(!/javascript|vbscript|data:/i.test(text), `leaked scheme: ${text}`);
    });
  }

  const allowed = ['/production', '/', '#section', 'https://x.example', 'http://x.example'];
  for (const href of allowed) {
    it(`allows ${href}`, () => {
      const out = parseRich(`[click](${href})`);
      assert.equal(out.length, 1);
      assert.equal(out[0].t, 'link');
    });
  }
});

describe('isPlain', () => {
  it('is true for text with no markup', () => {
    assert.equal(isPlain('nothing to see'), true);
  });

  it('is false when a link or emphasis is present', () => {
    assert.equal(isPlain('a [link](/x)'), false);
    assert.equal(isPlain('an *em*'), false);
  });

  it('does not leak lastIndex either', () => {
    const s = 'a [link](/x)';
    assert.equal(isPlain(s), false);
    assert.equal(isPlain(s), false);
  });
});

describe('bold', () => {
  it('parses **strong**', () => {
    assert.deepEqual(parseRich('**Stocking:** ten boards'), [
      {t: 'strong', v: 'Stocking:'},
      {t: 'text', v: ' ten boards'},
    ]);
  });

  it('does not mistake bold for two empty emphases', () => {
    // Emphasis is matched after bold for exactly this reason.
    const out = parseRich('**a**');
    assert.equal(out.length, 1);
    assert.equal(out[0].t, 'strong');
  });

  it('still handles single emphasis alongside bold', () => {
    const out = parseRich('**bold** and *em*');
    assert.deepEqual(
      out.map((n) => n.t),
      ['strong', 'text', 'em'],
    );
  });

  it('counts bold as markup', () => {
    assert.equal(isPlain('**x**'), false);
  });
});

describe('named link targets', () => {
  it('resolves @discord to the one invite in company.ts', () => {
    const [node] = parseRich('[Discord](@discord)');
    assert.equal(node.t, 'link');
    assert.ok(node.t === 'link' && node.href.startsWith('https://discord.gg/'));
    assert.ok(node.t === 'link' && node.external);
  });

  it('resolves @github', () => {
    const [node] = parseRich('[repos](@github)');
    assert.ok(node.t === 'link' && node.href.includes('github.com'));
  });

  it('an unknown name degrades to plain text rather than a broken link', () => {
    // A typo must not render an <a href="@nope">.
    const out = parseRich('[x](@nope)');
    assert.ok(!out.some((n) => n.t === 'link'));
  });
});
