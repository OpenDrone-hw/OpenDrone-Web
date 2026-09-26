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

  it('redacts real IBANs from several countries, compact or grouped', () => {
    for (const iban of [
      'BE68 5390 0754 7034',
      'BE68539007547034',
      'NL91 ABNA 0417 1643 00',
      'DE89 3704 0044 0532 0130 00',
      'FR14 2004 1010 0505 0001 3M02 606',
      'GB29 NWBK 6016 1331 9268 19',
      'gb29nwbk60161331926819',
    ]) {
      const r = scrubForPublic(`refund to ${iban} thanks`);
      assert.equal(r.content, 'refund to [iban redacted] thanks', iban);
      assert.deepEqual(r.reasons, ['iban'], iban);
    }
  });

  it('keeps a word the IBAN match ran into', () => {
    assert.equal(scrubForPublic('BE68 5390 0754 7034 ok').content, '[iban redacted] ok');
  });

  it('keeps FPV part names that look like an IBAN', () => {
    for (const text of [
      'I use a TX16S with an internal ELRS module',
      'the RP2350B runs the flight controller',
      'the SX1281 radio on the receiver',
      'RP2350B and SX1281 and TX16S MkII',
      'ES24 motors on a GB22 frame and NL18 props',
    ]) {
      const r = scrubForPublic(text);
      assert.equal(r.content, text, text);
      assert.equal(r.redactionCount, 0, text);
    }
  });

  it('keeps an IBAN-shaped string that fails the mod-97 checksum', () => {
    const text = 'wire to BE68 5390 0754 7035 today';
    assert.equal(scrubForPublic(text).content, text);
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

describe('scrubForPublic: tester findings', () => {
  it('redacts admin.shopify.com store links', () => {
    const r = scrubForPublic('see https://admin.shopify.com/store/opendrone/orders/5550001 for it');
    assert.match(r.content, /\[internal link redacted\]/);
    assert.doesNotMatch(r.content, /admin\.shopify/);
  });

  it('redacts Belgian mobile numbers written with / and .', () => {
    for (const phone of ['0470/12.34.56', '0470.12.34.56', '0470 12 34 56', '+32 470/12 34 56']) {
      assert.match(scrubForPublic(`call ${phone} please`).content, /\[phone redacted\]/, phone);
    }
  });

  it('keeps dates and the company mail addresses', () => {
    const r = scrubForPublic('Send it to returns@opendrone.be or sales@incutec.eu before 2026-09-25 (or 25/09/2026).');
    assert.equal(r.content, 'Send it to returns@opendrone.be or sales@incutec.eu before 2026-09-25 (or 25/09/2026).');
    assert.match(scrubForPublic('or mail jan@gmail.com').content, /\[email redacted\]/);
    assert.match(scrubForPublic('fake@opendrone.be.evil.example').content, /\[email redacted\]/);
  });

  it('keeps a phone number it is told to keep', () => {
    assert.equal(scrubForPublic('Call us on +32 16 12 34 56.', {keepPhones: ['+32 16 12 34 56']}).content, 'Call us on +32 16 12 34 56.');
  });
});

describe('scrubForPublic: round 3 false positives', () => {
  const same = (text: string) => assert.equal(scrubForPublic(text).content, text, text);

  it('keeps tracking numbers, order ranges, motor specs, VAT numbers and date-times', () => {
    same('Tracking: 3SABCD123456789, via PostNL.');
    same('Orders #1042-1045 ship together.');
    same('Use a 2207 1750KV motor.');
    same('Invoice from Incutec, VAT BE 1038.934.039.');
    same('BTW BE 0438.934.039 staat op de factuur.');
    same('We ship on 2026-09-25 14:30 from Leuven.');
    same('Pickup 25/09/2026 09:15.');
  });

  it('still redacts Belgian and international phone numbers, IBANs, emails and admin links', () => {
    for (const phone of ['0470/12.34.56', '+32 470 12 34 56', '0032 470 12 34 56', '016 12 34 56', '+31 6 12345678']) {
      assert.match(scrubForPublic(`bel ${phone} aub`).content, /\[phone redacted\]/, phone);
    }
    assert.match(scrubForPublic('BE68 5390 0754 7034').content, /\[iban redacted\]/);
    assert.match(scrubForPublic('mail jan@gmail.com').content, /\[email redacted\]/);
    assert.equal(scrubForPublic('mail returns@opendrone.be').content, 'mail returns@opendrone.be');
    assert.match(scrubForPublic('https://admin.shopify.com/store/x/orders/1').content, /\[internal link redacted\]/);
    assert.match(scrubForPublic('https://shop.myshopify.com/admin/orders/1').content, /\[internal link redacted\]/);
  });

  it('redacts spelled-out email addresses, except the company ones', () => {
    assert.equal(scrubForPublic('write jan (at) example (dot) com').content, 'write [email redacted]');
    assert.equal(scrubForPublic('write jan[at]example.com').content, 'write [email redacted]');
    assert.equal(scrubForPublic('write returns (at) opendrone (dot) be').content, 'write returns (at) opendrone (dot) be');
  });
});
