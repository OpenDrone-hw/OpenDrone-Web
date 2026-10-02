import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {isContentJson, stripContent} from './content-strip.ts';

describe('stripContent', () => {
  it('drops $comment keys at every depth and hidden entries', () => {
    const out = stripContent({
      $comment: 'editor note',
      $route: '/x',
      $comment_updates: 'editor note',
      goals: [{id: 'a', hidden: true}, {id: 'b', $comment: 'n', hidden: false}],
      nested: {$comment: 'n', keep: [1, 'two', null]},
    });
    assert.deepEqual(out, {
      $route: '/x',
      goals: [{id: 'b', hidden: false}],
      nested: {keep: [1, 'two', null]},
    });
  });

  it('removes the hidden goal and the goals note from content/goals.json', () => {
    const goals = JSON.parse(fs.readFileSync(new URL('../../content/goals.json', import.meta.url), 'utf8'));
    const text = JSON.stringify(stripContent(goals));
    assert.doesNotMatch(text, /\$comment|GOALS_INPUTS|pick and place/i);
  });

  it('matches content JSON only', () => {
    assert.ok(isContentJson('/repo/content/goals.json'));
    assert.ok(isContentJson('/repo/content/products/openfc.json?import'));
    assert.ok(!isContentJson('/repo/app/content/legal/en/shipping.md'));
    assert.ok(!isContentJson('/repo/package.json'));
  });
});
