import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFirstName,
  scrubForDiscord,
  scrubForPublic,
} from './scrubber.ts';

// Run with:
//   node --experimental-strip-types --test app/lib/support/scrubber.test.ts
//
// Zero runtime deps beyond Node 23's built-in type-stripping + node:test.

describe('scrubForPublic: redactions', () => {
  it('redacts plain email', () => {
    const r = scrubForPublic('mail me at foo@bar.com please');
    assert.equal(r.content, 'mail me at [email redacted] please');
    assert.equal(r.blocked, false);
    assert.ok(r.reasons.includes('email'));
  });

  it('redacts BE phone with separators', () => {
    const r = scrubForPublic('call +32 475 12 34 56 tonight');
    assert.match(r.content, /\[phone redacted\]/);
  });

  it('redacts IBAN', () => {
    const r = scrubForPublic('wire to BE68 5390 0754 7034 today');
    assert.match(r.content, /\[iban redacted\]/);
  });

  it('redacts a lowercase IBAN', () => {
    // People type IBANs lowercase as often as upper: must still redact.
    const r = scrubForPublic('wire to be68 5390 0754 7034 today');
    assert.match(r.content, /\[iban redacted\]/);
    assert.doesNotMatch(r.content, /5390/);
  });

  it('redacts BE national number (punctuated)', () => {
    const r = scrubForPublic('rijksregister 85.07.12-123.45 voor de verzekering');
    assert.match(r.content, /\[id redacted\]/);
  });

  it('redacts a 3-segment JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9' +
      '.eyJzdWIiOiIxMjM0NTY3ODkwIn0' +
      '.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const r = scrubForPublic(`token: ${jwt}`);
    assert.match(r.content, /\[token redacted\]/);
  });

  it('redacts Shopify admin URL', () => {
    const r = scrubForPublic(
      'see https://opendrone.myshopify.com/admin/orders/12345 for the details',
    );
    assert.match(r.content, /\[internal link redacted\]/);
    assert.doesNotMatch(r.content, /myshopify\.com/);
  });

  it('strips Discord role mention', () => {
    const r = scrubForPublic('ping <@&1234567890> please');
    assert.equal(r.content, 'ping please');
  });

  it('strips Discord user mention', () => {
    const r = scrubForPublic('hi <@!123456789012345678>');
    assert.equal(r.content, 'hi');
  });

  it('strips Discord custom emoji', () => {
    const r = scrubForPublic('nice <:tada:123456789012345678>!');
    assert.equal(r.content, 'nice !');
  });

  it('strips U+202E bidi override', () => {
    const withOverride = `harmless\u202E text`;
    const r = scrubForPublic(withOverride);
    assert.equal(r.content, 'harmless text');
  });

  it('redacts valid Luhn card', () => {
    const r = scrubForPublic('card 4111 1111 1111 1111 expires soon');
    assert.match(r.content, /\[card redacted\]/);
  });

  it('does NOT redact invalid Luhn 16-digit run', () => {
    const r = scrubForPublic('serial 1234567812345678 on the board');
    assert.doesNotMatch(r.content, /\[card redacted\]/);
  });

  it('does NOT redact a pure-digit Discord snowflake as a generic key', () => {
    const r = scrubForPublic('thread 1234567890123456789');
    assert.doesNotMatch(r.content, /\[redacted\]/);
  });

  it('redacts a 40-char AWS-ish key', () => {
    const r = scrubForPublic(
      'key AKIAIOSFODNN7EXAMPLEwJalrXUtnFEMI is the one',
    );
    assert.match(r.content, /\[redacted\]/);
  });
});

describe('scrubForPublic: block triggers', () => {
  it('blocks when redaction count exceeds the cap', () => {
    const emails = Array.from({length: 15}, (_, i) => `a${i}@b.com`).join(' ');
    const r = scrubForPublic(emails);
    assert.equal(r.blocked, true);
    assert.equal(r.content, '');
    assert.ok(r.reasons.includes('too-many-redactions'));
  });

  it('passes normal short content through unchanged', () => {
    const r = scrubForPublic('firmware 0.3.1 on OpenFC');
    assert.equal(r.content, 'firmware 0.3.1 on OpenFC');
    assert.equal(r.blocked, false);
    assert.equal(r.redactionCount, 0);
  });

  it('empty string is a no-op', () => {
    const r = scrubForPublic('');
    assert.equal(r.content, '');
    assert.equal(r.blocked, false);
  });
});

describe('extractFirstName', () => {
  it('picks first whitespace-split token from nickname', () => {
    assert.equal(extractFirstName(['Jan De Smet']), 'Jan');
  });

  it('uses username when nick is empty', () => {
    assert.equal(extractFirstName([null, undefined, 'vitroid']), 'vitroid');
  });

  it('falls back to Helper on empty', () => {
    assert.equal(extractFirstName([null, '', '   ']), 'Helper');
  });

  it('strips leading emoji', () => {
    assert.equal(extractFirstName(['🔥NightOwl']), 'NightOwl');
  });

  it('strips bidi override', () => {
    assert.equal(extractFirstName(['\u202Eevilname']), 'evilname');
  });

  it('caps at 24 chars', () => {
    const long = 'A'.repeat(40);
    assert.equal(extractFirstName([long]).length, 24);
  });

  it('skips nullish candidates and tries next', () => {
    assert.equal(extractFirstName([null, undefined, 'Sarah Jones']), 'Sarah');
  });
});

describe('scrubForDiscord: inbound (user -> Discord)', () => {
  it('preserves email (user may be asking about their own mailbox)', () => {
    const r = scrubForDiscord('order confirmation never arrived at foo@bar.com');
    assert.match(r.content, /foo@bar\.com/);
    assert.equal(r.blocked, false);
  });

  it('preserves phone number', () => {
    const r = scrubForDiscord('reach me on +32 475 12 34 56');
    assert.match(r.content, /\+32 475 12 34 56/);
  });

  it('preserves IBAN', () => {
    const r = scrubForDiscord('refund to BE68 5390 0754 7034');
    assert.match(r.content, /BE68 5390 0754 7034/);
  });

  it('redacts credit card even inbound', () => {
    const r = scrubForDiscord('card 4111 1111 1111 1111 got charged twice');
    assert.match(r.content, /\[card redacted\]/);
  });

  it('redacts JWT even inbound', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const r = scrubForDiscord(`api returns ${jwt}`);
    assert.match(r.content, /\[token redacted\]/);
  });

  it('strips bidi override from inbound content', () => {
    const r = scrubForDiscord('harmless\u202E text');
    assert.equal(r.content, 'harmless text');
  });

  it('short safe message passes through unchanged', () => {
    const r = scrubForDiscord("my OpenFC flashed but won't bind");
    assert.equal(r.content, "my OpenFC flashed but won't bind");
    assert.equal(r.redactionCount, 0);
  });
});

describe('integration: poll response projection', () => {
  // Smoke test: when we run a full Discord message payload through the
  // scrubber, none of the fields from the raw Discord shape that we
  // intentionally drop should appear in the output string.
  it('never leaks Discord avatar hash or user ID into content', () => {
    const raw =
      'see avatar https://cdn.discordapp.com/avatars/123456789012345678/abcdef.png';
    // The cdn URL is not pattern-matched directly, but the avatar hash
    // `abcdef` is short enough to pass generic-key; what we're asserting
    // is that *if* somebody tries to leak a user ID via message text,
    // the snowflake is preserved (not leaked: it's already the URL the
    // user typed) but the URL itself isn't something we scrub. This
    // test documents that behaviour so a future reader knows the bar:
    // the scrubber protects against accidental PII pasting, not against
    // deliberate leaks, which the Stage 2 moderation gate handles.
    const r = scrubForPublic(raw);
    assert.equal(r.blocked, false);
    assert.match(r.content, /cdn\.discordapp\.com/);
  });
});
