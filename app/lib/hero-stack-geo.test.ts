import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {batchOnePromises, geoShipText} from './geo-availability.ts';
import {shortShipPromise} from './product-content.ts';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const preorders = JSON.parse(read('../../content/preorders.json')) as Parameters<typeof batchOnePromises>[0];
const offer = read('../components/HeroStackOffer.tsx');

/** What the stack card shows for a promise and a region: the same rule as useGeoShipText, then the promise. */
function stackTag(promise: string, region: 'eu' | 'intl' | 'fallback'): string | undefined {
  const geo = batchOnePromises(preorders).has(promise) ? geoShipText(region, 'en') : null;
  return geo ?? shortShipPromise(promise)?.text;
}

test('the stack card reads its ship text from useGeoShipText, the same source as the availability bar', () => {
  assert.match(offer, /import \{useGeoShipText\} from '~\/components\/ShipChip';/);
  const hook = offer.indexOf('const geoShips = useGeoShipText(stack?.parts[0]?.shipPromise);');
  const early = offer.indexOf('if (!stack) return null;');
  assert.ok(hook > 0 && hook < early, 'hook runs before the early return (rules of hooks)');
  assert.match(offer, /const ships = geoShips \?\? shortShipPromise\(stack\.parts\[0\]\.shipPromise\)\?\.text;/);
  assert.doesNotMatch(offer, /useEffect|useState/, 'no client-only state: the server render is the final text');
});

test('EU visitors see the in-stock line, non-EU the pre-order line, unknown country the batch 1 promise', () => {
  const batch1 = 'ships late November 2026';
  assert.ok(batchOnePromises(preorders).has(batch1), 'the boards of the stack are batch 1 stock');
  assert.equal(stackTag(batch1, 'eu'), 'In stock in Belgium, ships in a few days.');
  assert.equal(stackTag(batch1, 'intl'), 'Pre-order, ships March 2027.');
  assert.equal(stackTag(batch1, 'fallback'), 'Ships late November 2026', 'unchanged from before');
});

test('a promise outside batch 1 keeps its own text in every region', () => {
  const other = 'ships late January 2027';
  for (const region of ['eu', 'intl', 'fallback'] as const) assert.equal(stackTag(other, region), 'Ships late January 2027');
});

test('the longer region line may wrap instead of overflowing the card', () => {
  assert.match(offer, /data-geo=\{geoShips \? '' : undefined\}/);
  assert.match(read('../styles/site-ui.css'), /\.hero-stack-ships\[data-geo\] \{[^}]*white-space: normal;/);
});
