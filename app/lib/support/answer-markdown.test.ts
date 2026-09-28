import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {parseAnswer, parseInline} from './answer-markdown.ts';

describe('parseAnswer (the ChatFPV helper Markdown subset)', () => {
  it('turns **bold** into a strong node, never literal stars', () => {
    const [b] = parseAnswer('* **OpenFC Lite 30x30:** Yes, 3-8S [1].');
    assert.equal(b.type, 'ul');
    assert.deepEqual((b as {items: unknown[][]}).items[0], [
      {t: 'strong', v: 'OpenFC Lite 30x30:'},
      {t: 'text', v: ' Yes, 3-8S '},
      {t: 'cite', n: 1},
      {t: 'text', v: '.'},
    ]);
  });
  it('keeps raw HTML as text', () => {
    assert.deepEqual(parseInline('<b>x</b> <script>alert(1)</script>'), [{t: 'text', v: '<b>x</b> <script>alert(1)</script>'}]);
  });
  it('links only http(s) URLs', () => {
    assert.deepEqual(parseInline('[a](https://x.test/p) [b](javascript:alert(1))'), [
      {t: 'link', v: 'a', href: 'https://x.test/p'},
      {t: 'text', v: ' [b](javascript:alert(1))'},
    ]);
  });
  it('parses paragraphs, headings, ordered lists, tables, code and emphasis', () => {
    const blocks = parseAnswer('## Steps\n1. Plug in\n2. Run `diff all`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nset x = 1\n```\nline one\nline *two*');
    assert.deepEqual(blocks.map((b) => b.type), ['h', 'ol', 'table', 'code', 'p']);
    assert.deepEqual(blocks[1], {type: 'ol', items: [[{t: 'text', v: 'Plug in'}], [{t: 'text', v: 'Run '}, {t: 'code', v: 'diff all'}]]});
    assert.deepEqual(blocks[2], {type: 'table', head: [[{t: 'text', v: 'a'}], [{t: 'text', v: 'b'}]], rows: [[[{t: 'text', v: '1'}], [{t: 'text', v: '2'}]]]});
    assert.deepEqual(blocks[3], {type: 'code', text: 'set x = 1'});
    assert.deepEqual(blocks[4], {type: 'p', lines: [[{t: 'text', v: 'line one'}], [{t: 'text', v: 'line '}, {t: 'em', v: 'two'}]]});
  });
  it('drops model end sentinels', () => {
    assert.deepEqual(parseAnswer('Done. END_OF_ANSWER'), [{type: 'p', lines: [[{t: 'text', v: 'Done.'}]]}]);
  });
});
