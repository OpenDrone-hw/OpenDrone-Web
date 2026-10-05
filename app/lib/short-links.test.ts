import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {SHORT_LINKS, shortLinkTarget} from './short-links.ts';

describe('short links', () => {
  it('maps the audited 404s', () => {
    assert.equal(shortLinkTarget('/opensource', ''), '/open-source');
    assert.equal(shortLinkTarget('/openesc', ''), '/products/openesc');
    assert.equal(shortLinkTarget('/github', ''), 'https://github.com/OpenDrone-hw');
    assert.equal(shortLinkTarget('/discord', ''), 'https://discord.gg/v3sWmTcx3R');
  });
  it('keeps the query string for internal targets, so ?ref= survives', () => {
    assert.equal(shortLinkTarget('/ESC/', '?ref=yt-s01'), '/products/openesc?ref=yt-s01');
    assert.equal(shortLinkTarget('/kit', '?ref=x'), '/?ref=x#build-guide');
  });
  it('leaves unknown paths alone', () => {
    assert.equal(shortLinkTarget('/nope', ''), null);
  });
  it('never targets itself', () => {
    for (const [from, to] of Object.entries(SHORT_LINKS)) assert.notEqual(from, to);
  });
});
