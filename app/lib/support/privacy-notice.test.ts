import assert from 'node:assert/strict';
import fs from 'node:fs';
import {describe, it} from 'node:test';
import {scrubForPublic} from './scrubber.ts';

/**
 * The ChatFPV data-use notice, on 3 surfaces, must never claim a scrubbing
 * behaviour the code does not actually perform.
 *
 * PR #503 shipped both notices saying
 * "Your name, email, phone and order numbers are removed first", but
 * `scrubForPublic` (the only scrubber the /support Ask box calls, via
 * `chatfpv.ts` `scrubOutbound`) never redacts a name or a bare order
 * number, and the widget iframe (`ChatFpvWidget.tsx`) sends the question
 * straight to ChatFPV client-side, through no scrubber at all. This file
 * pins the corrected wording against the two content sources
 * (`content/copy/chrome.json`, `content/copy/support.json`) and the code
 * fallbacks that render when a copy id is somehow missing (`ChatFpvWidget.tsx`,
 * `AskChatFPV.tsx`, `[llms.txt].tsx`), so the three can never drift back
 * apart, and against `scrubForPublic` itself, so a future change to the
 * scrubber's coverage would fail this test rather than silently make the
 * copy wrong again.
 */

const CHROME = JSON.parse(fs.readFileSync(new URL('../../../content/copy/chrome.json', import.meta.url), 'utf8')) as Record<string, string>;
const SUPPORT = JSON.parse(fs.readFileSync(new URL('../../../content/copy/support.json', import.meta.url), 'utf8')) as Record<string, string>;

const WIDGET_NOTICE = CHROME.chatfpv_widget_privacy_notice;
const ASK_NOTICE = SUPPORT.ask_privacy_notice;

/** A claim this notice text must never make: that the customer's name or
 *  order number is removed, scrubbed or redacted before sending. Neither
 *  surface's scrubbing covers either of these (see the two `it`s below), so
 *  the copy may only ask the visitor not to type them, never claim they are
 *  handled automatically. */
const FALSE_REMOVAL_CLAIM = /\b(?:name|order number)s?\b[^.]*\b(?:remove|redact|strip|scrub)/i;

describe('ChatFPV privacy notice: no claim beyond what scrubbing actually does', () => {
  it('scrubForPublic (the /support Ask box path) does not redact a name or a bare order number', () => {
    const r = scrubForPublic('My name is Sophie Dubois and order 10427 is late');
    assert.match(r.content, /Sophie Dubois/, 'a name must still pass through scrubForPublic for this test to be meaningful');
    assert.match(r.content, /10427/, 'a bare order number must still pass through scrubForPublic for this test to be meaningful');
  });

  it('scrubForPublic does redact what the /support notice claims it removes: email, phone, card, IBAN', () => {
    const r = scrubForPublic('Jan Peeters, order #OD-2231, email jan@example.com, phone +32 470 12 34 56, card 4111 1111 1111 1111, IBAN BE68 5390 0754 7034');
    assert.doesNotMatch(r.content, /jan@example\.com/);
    assert.doesNotMatch(r.content, /470 12 34 56/);
    assert.doesNotMatch(r.content, /4111 1111 1111 1111/);
    assert.doesNotMatch(r.content, /5390 0754 7034/);
    // The name and the order number are NOT claimed as auto-removed by the
    // fixed copy below, so they are expected to survive here too.
    assert.match(r.content, /Jan Peeters/);
    assert.match(r.content, /OD-2231/);
  });

  it('the /support notice (content/copy/support.json) makes no false removal claim', () => {
    assert.doesNotMatch(ASK_NOTICE, FALSE_REMOVAL_CLAIM, ASK_NOTICE);
    // It must still say plainly that the name/order number are the
    // customer's own responsibility to leave out.
    assert.match(ASK_NOTICE, /name or order number/i);
  });

  it('the widget notice (content/copy/chrome.json) makes no false removal claim, and says the question is sent as typed', () => {
    assert.doesNotMatch(WIDGET_NOTICE, FALSE_REMOVAL_CLAIM, WIDGET_NOTICE);
    assert.match(WIDGET_NOTICE, /as you type it|as typed/i);
  });

  it('neither notice claims scrubbing that only the OTHER surface performs (widget scrubs nothing at all)', () => {
    // The widget is a client-side iframe straight to ChatFPV: it never
    // calls scrubOutbound/scrubForPublic, so its notice must not claim any
    // redaction happens, only that the visitor should leave sensitive data
    // out themselves.
    assert.doesNotMatch(WIDGET_NOTICE, /\bremov(?:e|ed|es)\b|\bredact/i, WIDGET_NOTICE);
  });
});

describe('ChatFPV privacy notice: single source, no silent drift', () => {
  it('ChatFpvWidget.tsx and [llms.txt].tsx fall back to the exact chrome.json widget notice', () => {
    const widget = fs.readFileSync(new URL('../../components/ChatFpvWidget.tsx', import.meta.url), 'utf8');
    const llms = fs.readFileSync(new URL('../../routes/[llms.txt].tsx', import.meta.url), 'utf8');
    assert.ok(widget.includes(WIDGET_NOTICE), 'ChatFpvWidget.tsx PRIVACY_NOTICE_FALLBACK must match chrome.json chatfpv_widget_privacy_notice');
    assert.ok(llms.includes(WIDGET_NOTICE), '[llms.txt].tsx widget fallback must match chrome.json chatfpv_widget_privacy_notice');
  });

  it('AskChatFPV.tsx and [llms.txt].tsx fall back to the exact support.json ask notice', () => {
    const ask = fs.readFileSync(new URL('../../components/support/AskChatFPV.tsx', import.meta.url), 'utf8');
    const llms = fs.readFileSync(new URL('../../routes/[llms.txt].tsx', import.meta.url), 'utf8');
    assert.ok(ask.includes(ASK_NOTICE), 'AskChatFPV.tsx fallback must match support.json ask_privacy_notice');
    assert.ok(llms.includes(ASK_NOTICE), '[llms.txt].tsx support fallback must match support.json ask_privacy_notice');
  });
});
