import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {attributionFields, cartAttributesFromForm, contentValue, foldSource, referrerHost, refSlug} from './attribution.ts';

describe('attribution', () => {
  it('accepts creator slugs only', () => {
    assert.equal(refSlug(' Alice-FPV '), 'alice-fpv');
    assert.equal(refSlug('a_b9'), 'a_b9');
    assert.equal(refSlug('-lead'), undefined);
    assert.equal(refSlug('has space'), undefined);
    assert.equal(refSlug('x'.repeat(33)), undefined);
    assert.equal(refSlug(null), undefined);
  });

  it('turns a record into form fields, keeping ref and utm_source apart', () => {
    assert.deepEqual(attributionFields(null), []);
    assert.deepEqual(
      attributionFields({source: 'alice', ref: 'alice', landing: '/products/openfc', ts: 1}),
      [['attr_ref', 'alice'], ['attr_landing', '/products/openfc']],
    );
    assert.deepEqual(
      attributionFields({source: 'youtube', utmSource: 'youtube', medium: 'video', campaign: 'launch', ref: 'bob', landing: '/', ts: 1}),
      [['attr_ref', 'bob'], ['attr_utmSource', 'youtube'], ['attr_medium', 'video'], ['attr_campaign', 'launch'], ['attr_landing', '/']],
    );
    // A record written before utmSource existed.
    assert.deepEqual(attributionFields({source: 'reddit', landing: '/', ts: 1}), [['attr_utmSource', 'reddit'], ['attr_landing', '/']]);
  });

  it('validates the form fields into order attributes and drops the rest', () => {
    const form = new FormData();
    form.set('attr_ref', 'Alice');
    form.set('attr_utmSource', 'youtube');
    form.set('attr_medium', 'bad value<script>');
    form.set('attr_campaign', 'launch-openfc');
    form.set('attr_landing', '/products/openfc');
    form.set('attr_other', 'ignored');
    assert.deepEqual(cartAttributesFromForm(form), [
      {key: '_ref', value: 'alice'},
      {key: '_utm_source', value: 'youtube'},
      {key: '_utm_campaign', value: 'launch-openfc'},
      {key: '_landing', value: '/products/openfc'},
    ]);
    const bad = new FormData();
    bad.set('attr_landing', 'https://evil.example/');
    bad.set('attr_ref', '../x');
    assert.deepEqual(cartAttributesFromForm(bad), []);
  });

  it('keeps the video id of utm_content with its case', () => {
    assert.equal(contentValue(' dQw4w9WgXcQ '), 'dQw4w9WgXcQ');
    assert.equal(contentValue('a b'), undefined);
    assert.equal(contentValue('x'.repeat(65)), 'x'.repeat(64));
    assert.equal(contentValue(null), undefined);
  });

  it('keeps only the host of an external referrer', () => {
    assert.equal(referrerHost('https://www.youtube.com/watch?v=abc', 'opendrone.be'), 'www.youtube.com');
    assert.equal(referrerHost('https://opendrone.be/products/openfc', 'opendrone.be'), undefined);
    assert.equal(referrerHost('https://www.opendrone.be/', 'www.opendrone.be'), undefined);
    assert.equal(referrerHost('android-app://com.google.android.youtube/', 'opendrone.be'), undefined);
    assert.equal(referrerHost('', 'opendrone.be'), undefined);
    assert.equal(referrerHost('not a url', 'opendrone.be'), undefined);
  });

  it('a referrer-only visit stays direct in event props and sends no utm_source', () => {
    assert.equal(foldSource('referrer'), 'direct');
    assert.deepEqual(
      attributionFields({source: 'referrer', referrer: 'www.youtube.com', landing: '/', ts: 1}),
      [['attr_referrer', 'www.youtube.com'], ['attr_landing', '/']],
    );
    assert.deepEqual(
      attributionFields({source: 'youtube', utmSource: 'youtube', content: 'dQw4w9WgXcQ', landing: '/', ts: 1}),
      [['attr_utmSource', 'youtube'], ['attr_content', 'dQw4w9WgXcQ'], ['attr_landing', '/']],
    );
  });

  it('validates utm_content and the referrer host into order attributes', () => {
    const form = new FormData();
    form.set('attr_utmSource', 'youtube');
    form.set('attr_content', 'dQw4w9WgXcQ');
    form.set('attr_referrer', 'www.youtube.com');
    assert.deepEqual(cartAttributesFromForm(form), [
      {key: '_utm_source', value: 'youtube'},
      {key: '_utm_content', value: 'dQw4w9WgXcQ'},
      {key: '_referrer', value: 'www.youtube.com'},
    ]);
    const bad = new FormData();
    bad.set('attr_content', '<script>');
    bad.set('attr_referrer', 'https://evil.example/path');
    assert.deepEqual(cartAttributesFromForm(bad), []);
  });
});
