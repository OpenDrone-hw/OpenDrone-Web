import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {attributionFields, cartAttributesFromForm, referrerHost, refSlug} from './attribution.ts';

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

  it('keeps a direct visit as a record that still writes the landing marker', () => {
    // No utm, no ref, no referrer: the marker alone says the visit was captured and had no source.
    assert.deepEqual(attributionFields({source: '', landing: '/products/openfc', ts: 1}), [['attr_landing', '/products/openfc']]);
    assert.deepEqual(
      attributionFields({source: '', referrer: 'www.google.com', landing: '/', ts: 1}),
      [['attr_referrer', 'www.google.com'], ['attr_landing', '/']],
    );
    const form = new FormData();
    form.set('attr_landing', '/');
    form.set('attr_referrer', 'WWW.Google.com');
    assert.deepEqual(cartAttributesFromForm(form), [{key: '_referrer', value: 'www.google.com'}, {key: '_landing', value: '/'}]);
    const bad = new FormData();
    bad.set('attr_referrer', 'https://evil.example/x?y=1');
    assert.deepEqual(cartAttributesFromForm(bad), []);
  });

  it('reduces a document.referrer to an external host', () => {
    assert.equal(referrerHost('https://www.google.com/search?q=openfc', 'opendrone.be'), 'www.google.com');
    assert.equal(referrerHost('https://www.youtube.com/watch?v=x', 'opendrone.be'), 'www.youtube.com');
    assert.equal(referrerHost('https://opendrone.be/products', 'opendrone.be'), undefined);
    assert.equal(referrerHost('https://www.opendrone.be/', 'opendrone.be'), undefined);
    assert.equal(referrerHost('', 'opendrone.be'), undefined);
    assert.equal(referrerHost('not a url', 'opendrone.be'), undefined);
  });
});
