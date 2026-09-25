import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {EU_COUNTRIES} from './shipping-rates.ts';
import {COUNTRY_LANGUAGES, WARNING_LANGUAGES, warningLanguages} from './gpsr-languages.ts';

const COPY = JSON.parse(
  fs.readFileSync(new URL('../../content/copy/product-chrome.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

describe('warningLanguages', () => {
  it('shows English and the visitor country language, folds the rest', () => {
    const de = warningLanguages('DE');
    assert.deepEqual(de.shown, ['en', 'de']);
    assert.ok(!de.folded.includes('de') && !de.folded.includes('en'));
    assert.ok(de.folded.includes('nl') && de.folded.includes('fr'));
    assert.equal(de.shown.length + de.folded.length, WARNING_LANGUAGES.length);
  });

  it('shows every official language of a multilingual country', () => {
    assert.deepEqual(warningLanguages('BE').shown, ['en', 'nl', 'fr', 'de']);
    assert.deepEqual(warningLanguages('LU').shown, ['en', 'fr', 'de']);
    assert.deepEqual(warningLanguages('FI').shown, ['en', 'fi', 'sv']);
    assert.deepEqual(warningLanguages('nl').shown, ['en', 'nl']);
  });

  it('shows English alone for Ireland, Malta, outside the EU and an unknown country', () => {
    for (const c of ['IE', 'MT', 'US', 'GB', null]) {
      const r = warningLanguages(c);
      assert.deepEqual(r.shown, ['en'], String(c));
      assert.equal(r.folded.length, WARNING_LANGUAGES.length - 1, String(c));
    }
  });

  it('covers the EU27, with warnings in every language it names', () => {
    assert.deepEqual(Object.keys(COUNTRY_LANGUAGES).sort(), [...EU_COUNTRIES].sort());
    for (const lang of WARNING_LANGUAGES) {
      for (const key of [`gpsr_warnings_${lang}`, ...['electronics', 'frame', 'motor'].map((k) => `gpsr_warnings_${k}_${lang}`)]) {
        assert.ok(Array.isArray(COPY[key]) && (COPY[key] as unknown[]).length > 0, key);
      }
    }
  });
});
