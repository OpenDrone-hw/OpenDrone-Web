import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {cleanOptions, readOptions, writeOptions} from './app-cart-options.ts';

const ENV = {SESSION_SECRET: 'test-secret'};

describe('cart options', () => {
  it('keeps a plain code and a real boolean, drops everything else', () => {
    assert.deepEqual(cleanOptions({code: ' spring-10 ', pickup: true}), {code: 'spring-10', pickup: true, attributes: {}});
    assert.deepEqual(cleanOptions({code: 'a b<script>', pickup: 'yes'}), {code: 'abscript', pickup: false, attributes: {}});
    assert.deepEqual(cleanOptions({code: 'x'.repeat(100)}).code.length, 40);
    assert.deepEqual(cleanOptions(null), {code: '', pickup: false, attributes: {}});
    assert.deepEqual(cleanOptions({attributes: {_landing: '/x', _referrer: 'www.google.com', _ref: ' a ', _utm_term: 'x', _utm_source: 'y'.repeat(201), _utm_medium: 'a\nb', _utm_content: 5}}).attributes, {_landing: '/x', _referrer: 'www.google.com', _ref: 'a'});
  });

  it('round-trips through the signed cookie and refuses a forged one', async () => {
    const set = await writeOptions({code: 'TENOFF', pickup: true, attributes: {_ref: 'r'}}, ENV);
    const request = new Request('https://shop.example/', {headers: {Cookie: set.split(';')[0]}});
    assert.deepEqual(await readOptions(request, ENV), {code: 'TENOFF', pickup: true, attributes: {_ref: 'r'}});
    const forged = new Request('https://shop.example/', {headers: {Cookie: 'od_app_cart_options=eyJjb2RlIjoiWCJ9'}});
    assert.deepEqual(await readOptions(forged, ENV), {code: '', pickup: false, attributes: {}});
  });
});
