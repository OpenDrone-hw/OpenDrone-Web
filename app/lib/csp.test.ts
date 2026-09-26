import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {chatFpvFrameSrc, createContentSecurityPolicy} from './csp.ts';

const URL_ = 'https://chatfpv.sales-ee0.workers.dev';
const frameSrc = (header: string) => header.split('; ').find((d) => d.startsWith('frame-src '))!;

describe('ChatFPV frame-src', () => {
  it('adds the ChatFPV origin only while CHATFPV_WIDGET_ENABLED is 1', () => {
    assert.deepEqual(chatFpvFrameSrc({CHATFPV_URL: URL_, CHATFPV_WIDGET_ENABLED: '0'}), []);
    assert.deepEqual(chatFpvFrameSrc({CHATFPV_URL: URL_}), []);
    assert.deepEqual(chatFpvFrameSrc({CHATFPV_URL: `${URL_}/embed`, CHATFPV_WIDGET_ENABLED: '1'}), [URL_]);
    assert.deepEqual(chatFpvFrameSrc({CHATFPV_URL: 'http://chatfpv.test', CHATFPV_WIDGET_ENABLED: '1'}), []);
    assert.deepEqual(chatFpvFrameSrc({CHATFPV_URL: 'not a url', CHATFPV_WIDGET_ENABLED: '1'}), []);
  });

  it('reaches the served policy through entry.server, in frame-src only', () => {
    const src = readFileSync(new URL('../entry.server.tsx', import.meta.url), 'utf8');
    assert.match(src, /frameSrc: \[[^\]]*\.\.\.chatFpvFrameSrc\(context\.env\)/);
    const on = createContentSecurityPolicy({frameSrc: ["'self'", ...chatFpvFrameSrc({CHATFPV_URL: URL_, CHATFPV_WIDGET_ENABLED: '1'})]}).header;
    const off = createContentSecurityPolicy({frameSrc: ["'self'", ...chatFpvFrameSrc({CHATFPV_URL: URL_, CHATFPV_WIDGET_ENABLED: '0'})]}).header;
    assert.equal(frameSrc(on), `frame-src 'self' ${URL_}`);
    assert.equal(frameSrc(off), "frame-src 'self'");
    assert.equal(on.split(URL_).length - 1, 1, 'the origin appears in frame-src only');
  });
});
