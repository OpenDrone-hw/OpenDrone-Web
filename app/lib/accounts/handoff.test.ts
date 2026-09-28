import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {chatFpvFrameSrc} from '../csp.ts';
import {handoffEnabled, handoffPlacement, parseHandoffFragment, takeHandoffTicket, withHandoffTicket} from './handoff.ts';

const TICKET = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'; // 43 base64url chars
const SRC = 'https://chatfpv.com/embed?mode=opendrone&product=openfc-lite&page=product';
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function fakeWindow(href: string) {
  const url = new URL(href);
  const calls: {state: unknown; url?: string | URL | null}[] = [];
  const win = {
    location: {hash: url.hash, href: url.href},
    history: {
      state: {key: 'k'},
      replaceState(state: unknown, _unused: string, next?: string | URL | null) {
        calls.push({state, url: next});
      },
    },
  };
  return {win, calls};
}

describe('HANDOFF_ENABLED', () => {
  it('is on only for "1"', () => {
    assert.equal(handoffEnabled({HANDOFF_ENABLED: '1'}), true);
    assert.equal(handoffEnabled({HANDOFF_ENABLED: ' 1 '}), true);
    assert.equal(handoffEnabled({HANDOFF_ENABLED: '0'}), false);
    assert.equal(handoffEnabled({HANDOFF_ENABLED: 'true'}), false);
    assert.equal(handoffEnabled({}), false);
  });
});

describe('#cfh fragment', () => {
  it('parses a 43-character base64url ticket only', () => {
    assert.equal(parseHandoffFragment(`#cfh=${TICKET}`), TICKET);
    assert.equal(parseHandoffFragment(`cfh=${TICKET}`), TICKET);
    assert.equal(parseHandoffFragment(''), null);
    assert.equal(parseHandoffFragment('#specs'), null);
    assert.equal(parseHandoffFragment(`#cfh=${TICKET}x`), null);
    assert.equal(parseHandoffFragment(`#cfh=${TICKET.slice(1)}`), null);
    assert.equal(parseHandoffFragment(`#cfh=${TICKET.slice(1)}=`), null);
    assert.equal(parseHandoffFragment(`#cfh=${TICKET}&x=1`), null);
    assert.equal(parseHandoffFragment(`#cfh=${TICKET.slice(3)}"><s`), null);
  });

  it('reads the ticket and clears the fragment, keeping path and query', () => {
    const {win, calls} = fakeWindow(`https://opendrone.be/products/openfc-lite?Model=30%C3%9730#cfh=${TICKET}`);
    assert.equal(takeHandoffTicket(win), TICKET);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/products/openfc-lite?Model=30%C3%9730', "the card's variant selection is kept");
    assert.deepEqual(calls[0].state, {key: 'k'}, 'router history state is kept');
  });

  it('clears an invalid #cfh fragment without returning a ticket', () => {
    const {win, calls} = fakeWindow('https://opendrone.be/products/openfc-lite#cfh=short');
    assert.equal(takeHandoffTicket(win), null);
    assert.equal(calls[0].url, '/products/openfc-lite');
  });

  it('leaves other fragments and plain URLs untouched', () => {
    for (const href of ['https://opendrone.be/products/openfc-lite#specs', 'https://opendrone.be/products/openfc-lite?variant=1']) {
      const {win, calls} = fakeWindow(href);
      assert.equal(takeHandoffTicket(win), null);
      assert.equal(calls.length, 0);
    }
  });

  it('puts the ticket in the iframe src fragment, never the query', () => {
    const out = new URL(withHandoffTicket(SRC, TICKET));
    assert.equal(out.hash, `#cfh=${TICKET}`);
    assert.equal(out.search, new URL(SRC).search, 'query parameters unchanged');
    assert.ok(![...out.searchParams.values()].includes(TICKET));
    assert.ok(!out.search.includes('cfh'));
    assert.equal(new URL(withHandoffTicket(`${SRC}#old`, TICKET)).hash, `#cfh=${TICKET}`);
  });
});

describe('handoffPlacement', () => {
  // Product column rects measured on opendrone.be/products/openfc-lite (.product-hero-copy).
  it('opens beside the product column on the left at 1440 and 1024 (no room on the right)', () => {
    assert.deepEqual(handoffPlacement(1440, {left: 815, right: 1271}), {side: 'left', width: 400});
    assert.deepEqual(handoffPlacement(1024, {left: 593, right: 968}), {side: 'left', width: 400});
  });

  it('opens on the right when the right gutter has room (1920)', () => {
    assert.deepEqual(handoffPlacement(1920, {left: 1055, right: 1511}), {side: 'right', width: 377});
  });

  it('never opens over a one-column phone layout or an unknown page', () => {
    assert.equal(handoffPlacement(390, {left: 19, right: 371}), null);
    assert.equal(handoffPlacement(800, {left: 300, right: 500}), null);
    assert.equal(handoffPlacement(1440, null), null);
  });
});

describe('widget wiring', () => {
  const widget = read('../../components/ChatFpvWidget.tsx');
  const route = read('../../routes/products.$handle.tsx');

  it('reads #cfh only when the handoff prop is on, and otherwise uses src unchanged', () => {
    assert.match(widget, /handoff = false/);
    assert.match(widget, /if \(!handoff \|\| !src \|\| handoffRead\.current\) return;/);
    assert.match(widget, /takeHandoffTicket\(window\)/);
    assert.match(widget, /setHandoffSrc\(withHandoffTicket\(src, ticket\)\)/);
    assert.match(widget, /src=\{handoffSrc \?\? src\}/);
  });

  it('docks or badges a handed-off conversation instead of covering the product column', () => {
    assert.match(widget, /handoffPlacement\(window\.innerWidth, column\)/);
    assert.match(widget, /setUnread\(true\)/);
    assert.match(widget, /\{mounted \? \(/);
    assert.match(widget, /display: open \? 'flex' : 'none'/);
  });

  it('keeps the sandbox open for the "Continue on chatfpv.com" new tab', () => {
    const sandbox = /sandbox="([^"]+)"/.exec(widget)?.[1].split(' ') ?? [];
    for (const token of ['allow-scripts', 'allow-same-origin', 'allow-popups', 'allow-popups-to-escape-sandbox']) {
      assert.ok(sandbox.includes(token), token);
    }
  });

  it('passes HANDOFF_ENABLED from the product loader to both widget renders', () => {
    assert.match(route, /chatfpvHandoff: handoffEnabled\(args\.context\.env\)/);
    assert.equal(route.split('handoff={chatfpvHandoff}').length - 1, 2);
  });
});

describe('wrangler configs', () => {
  const prod = read('../../../wrangler.production.toml');
  const staging = read('../../../wrangler.toml');
  const value = (toml: string, name: string) => new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];

  it('production turns handoff on and points at the canonical ChatFPV origin', () => {
    assert.equal(value(prod, 'HANDOFF_ENABLED'), '1');
    assert.equal(value(prod, 'ACCOUNTS_ENABLED'), '1');
    assert.equal(value(prod, 'CHATFPV_URL'), 'https://chatfpv.com');
    assert.deepEqual(chatFpvFrameSrc({CHATFPV_URL: value(prod, 'CHATFPV_URL'), CHATFPV_WIDGET_ENABLED: '1'}), ['https://chatfpv.com']);
  });

  it('production never sets ACCOUNTS_TEST_IDP', () => {
    assert.doesNotMatch(prod, /^\s*ACCOUNTS_TEST_IDP\s*=/m);
  });

  it('staging turns handoff on like the other ChatFPV switches', () => {
    assert.equal(value(staging, 'HANDOFF_ENABLED'), '1');
    assert.equal(value(staging, 'CHATFPV_WIDGET_ENABLED'), '1');
  });
});
