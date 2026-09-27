import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';

/** app/styles/opendrone-tokens.css is vendored from OpenDrone/brand (scripts/check-tokens.mjs). */
const tokens = readFileSync(new URL('./opendrone-tokens.css', import.meta.url));
const app = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

describe('vendored OpenDrone tokens', () => {
  it('bytes after the header hash to the brand file SHA-256 the header names', () => {
    const nl = tokens.indexOf(0x0a);
    const header = /commit ([0-9a-f]{40}) tokens\/dist\/opendrone-tokens\.css, sha256 ([0-9a-f]{64})\./.exec(tokens.subarray(0, nl).toString('utf8'));
    assert.ok(header, 'vendoring header');
    assert.equal(createHash('sha256').update(tokens.subarray(nl + 1)).digest('hex'), header[2]);
  });

  it('app.css imports the tokens and holds no gold literal of its own', () => {
    assert.match(app, /@import "\.\/opendrone-tokens\.css";/);
    assert.equal(app.match(/#ffb700/gi)?.length ?? 0, 0);
    assert.match(app, /--color-gold: var\(--od-color-brand-gold\);/);
  });
});
