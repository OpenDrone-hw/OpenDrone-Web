import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const src = readFileSync(new URL('../routes/_index.tsx', import.meta.url), 'utf8');

// Mobile home CLS 0.25-0.28: a narrow window whose UA has no "Mobi" hint got
// the desktop SSR tree with streamed build/featured data; after matchMedia
// swapped to MobileHome the data landed late and shifted the ledger.
test('the home loader resolves build and featured data for every visitor', () => {
  assert.match(src, /const \{heroBuilds, featured\} = await home;/);
  assert.doesNotMatch(src, /isMobileHint\s*\?\s*await/);
});

test('Sec-CH-UA-Mobile counts as a phone hint', () => {
  assert.match(src, /request\.headers\.get\('sec-ch-ua-mobile'\) === '\?1'/);
});
