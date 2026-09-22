import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {helpText, termWords} from './catalog-search.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/catalog-search.test.ts

describe('termWords', () => {
  it('reads Dutch motor words as motor', () => {
    assert.deepEqual(termWords('motoren'), ['motor']);
  });
  it('reads French motor words as motor', () => {
    assert.deepEqual(termWords('moteurs'), ['motor']);
    assert.deepEqual(termWords('moteur'), ['motor']);
  });
  it('reads Dutch receiver words as receiver', () => {
    assert.deepEqual(termWords('ontvanger'), ['receiver']);
    assert.deepEqual(termWords('ELRS ontvanger'), ['elrs', 'receiver']);
  });
  it('reads French receiver words, with or without accents', () => {
    assert.deepEqual(termWords('récepteur'), ['receiver']);
    assert.deepEqual(termWords('recepteurs'), ['receiver']);
  });
  it('reads châssis as frame', () => {
    assert.deepEqual(termWords('châssis'), ['frame']);
  });
  it('reads the Dutch and French flight controller words', () => {
    assert.deepEqual(termWords('vluchtcontroller'), ['flight', 'controller']);
    assert.deepEqual(termWords('contrôleur de vol'), ['flight', 'controller']);
  });
  it('reads regelaar and variateur as ESC', () => {
    assert.deepEqual(termWords('regelaar'), ['esc']);
    assert.deepEqual(termWords('variateur'), ['esc']);
  });
  it('keeps sizes, mount patterns and radio bands', () => {
    assert.deepEqual(termWords('5 inch motoren'), ['5inch', 'motor']);
    assert.deepEqual(termWords('20 x 20'), ['20x20']);
    assert.deepEqual(termWords('915 MHz'), ['sub-ghz']);
  });
});

describe('helpText', () => {
  it('translates before the help patterns see the term', () => {
    assert.equal(helpText('Vluchtcontroller'), 'flight controller');
    assert.equal(helpText('7 inch'), '7inch');
  });
});
