// Outbound-message scrubber for the Discord -> web-support bridge.
//
// Discord thread replies pass through `scrubForPublic` before reaching the
// browser widget. This is the trust boundary: nothing in a Discord
// message is considered public until it's been projected through here.
//
// Pure functions, no fetch / no crypto / no React: runnable under
// `node --test` without transpilation (Node 23's --experimental-strip-types).
//
// Related files: `api.support.poll.tsx` (caller), `discord.ts` (raw
// fetcher), `scrubber.test.ts` (test suite).

export type PublicRole = 'helper' | 'self';

export type PublicMessage = {
  id: string;
  role: PublicRole;
  firstName: string;
  content: string;
  createdAt: string;
  attachments: Array<{url: string; filename: string}>;
};

export type ScrubResult = {
  content: string;
  blocked: boolean;
  redactionCount: number;
  reasons: string[];
};

// Hard caps. A Discord message is capped at 2000 chars server-side, so
// anything we poll back beyond ~4 KB after decoding is either abnormal
// or an embed payload we don't want to surface.
const MAX_POST_SCRUB_LENGTH = 4000;
const MAX_REDACTIONS = 10;

// Regex pipeline. Order matters:
//   bidi/control chars first (so following regex sees clean text),
//   structured high-entropy values next (JWT, card, IBAN),
//   then loose matchers (email, phone, long hex).
// Each entry is a single-pass replacement.
type Pattern = {
  name: string;
  re: RegExp;
  replace: string;
};

// Bidi-override block (U+202A-U+202E, U+2066-U+2069) and C0/C1 control
// chars (minus TAB/LF/CR). RegExp constructor form keeps ESLint
// no-irregular-whitespace / no-control-regex quiet by avoiding literal
// chars in the source, and the \uXXXX escapes document the ranges.
const BIDI_RANGE = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069]', 'g');
/* eslint-disable no-control-regex */
const CONTROL_RANGE = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]',
  'g',
);
/* eslint-enable no-control-regex */

const PATTERNS: Pattern[] = [
  // JWT (`eyJ` header is base64 for `{"`: strong signal)
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: '[token redacted]',
  },
  // Discord bot token (base64.base64.base64 where first segment is
  // base64url of user-id). Very specific shape: put before generic
  // long-hex so we label it correctly.
  {
    name: 'discord-token',
    re: /\b[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g,
    replace: '[token redacted]',
  },
  // Shopify admin URLs: these leak internal order / customer IDs.
  {
    name: 'shopify-admin-url',
    re: /https?:\/\/[\w.-]+\.(?:myshopify\.com|shopify\.com)\/admin[^\s]*/gi,
    replace: '[internal link redacted]',
  },
  // IBAN: country code + 2 check digits + 11-30 alphanumeric.
  // Match with optional spaces every 4 chars (standard presentation).
  // `i` flag: people type IBANs lowercase ("be68 ...") as often as upper,
  // and an unredacted IBAN in the public channel is a real PII leak.
  {
    name: 'iban',
    re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/gi,
    replace: '[iban redacted]',
  },
  // Belgian national number: punctuated presentation only
  // (YY.MM.DD-XXX.XX). The bare 11-digit form is intentionally NOT
  // matched: a naked \d{11} would swallow Discord snowflakes, order
  // numbers, and firmware values. We accept that gap rather than
  // over-redact legitimate content.
  {
    name: 'be-natl-punct',
    re: /\b\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{2}\b/g,
    replace: '[id redacted]',
  },
  // Email addresses. Deliberately simple: we prefer false positives
  // (over-redacting a string that looks like an email) to false negatives.
  {
    name: 'email',
    re: /\b[\w.+-]+@[\w-]+(?:\.[\w.-]+)+\b/g,
    replace: '[email redacted]',
  },
  // Discord mentions: <@123>, <@!123>, <#123>, <@&123>, <:emojiname:123>.
  // These leak internal server structure (role IDs, specific users,
  // channel names) that the customer should never see. Strip entirely.
  {
    name: 'discord-mention',
    re: /<(?:@!?|#|@&|a?:[A-Za-z0-9_]+:)\d{6,22}>/g,
    replace: '',
  },
];

// Phone-number detection is done after the above because naive phone
// regex will eat Discord numeric IDs. After mentions are stripped, we
// can look for runs of digits with typical phone separators.
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

// Payment card. Luhn-validate to reduce false positives on serial
// numbers, Discord IDs, and firmware build hashes.
const CARD_RE = /(?<!\w)(?:\d[ -]?){13,19}(?!\w)/g;

// Long alphanumeric blobs: catch generic API keys / tokens we don't
// otherwise pattern-match. Run last. Minimum 32 chars, alphanumeric
// (with optional - and _). We exclude pure-digit runs (those are often
// Discord snowflake IDs; if they're sensitive, a more specific pattern
// above already caught them).
const GENERIC_KEY_RE = /\b(?=\w*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;

export function scrubForPublic(raw: string): ScrubResult {
  if (!raw) {
    return {content: '', blocked: false, redactionCount: 0, reasons: []};
  }
  let content = raw;
  const reasons: string[] = [];
  let redactions = 0;

  try {
    content = content.replace(BIDI_RANGE, '');
    content = content.replace(CONTROL_RANGE, '');

    for (const p of PATTERNS) {
      content = content.replace(p.re, () => {
        redactions += 1;
        reasons.push(p.name);
        return p.replace;
      });
    }

    content = content.replace(PHONE_RE, (match) => {
      // Don't redact short runs that are just version numbers (`1.2.3.4`)
      // or IPs: the pattern already requires 8+ digits, so we mainly
      // guard against "build 12345678" style strings by checking for any
      // punctuation that isn't digit-or-separator. The regex itself
      // already does that, but we also want to skip strings that are
      // mostly dots (version) vs mostly spaces/dashes (phone).
      const digits = match.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) return match;
      redactions += 1;
      reasons.push('phone');
      return '[phone redacted]';
    });

    content = content.replace(CARD_RE, (match) => {
      const digits = match.replace(/[^0-9]/g, '');
      if (digits.length < 13 || digits.length > 19) return match;
      if (!luhnValid(digits)) return match;
      redactions += 1;
      reasons.push('card');
      return '[card redacted]';
    });

    content = content.replace(GENERIC_KEY_RE, (match) => {
      // Discord snowflake IDs are pure digits: leave those to the
      // mention/URL patterns. This regex already excludes pure-digit
      // matches via the lookahead, but be explicit.
      if (/^\d+$/.test(match)) return match;
      // Don't redact common harmless identifiers (semver builds, git
      // SHAs under 32 chars are already excluded by the 32-char floor).
      redactions += 1;
      reasons.push('generic-key');
      return '[redacted]';
    });
  } catch (err) {
    // Regex engines don't normally throw on String.replace, but if
    // something upstream hands us a pathological input, fail closed.
    return {
      content: '',
      blocked: true,
      redactionCount: 0,
      reasons: ['scrubber-exception', String(err)],
    };
  }

  // Collapse run of spaces left behind by stripped mentions.
  content = content.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
  content = content.trim();

  if (content.length > MAX_POST_SCRUB_LENGTH) {
    return {
      content: '',
      blocked: true,
      redactionCount: redactions,
      reasons: [...reasons, 'too-long'],
    };
  }

  if (redactions > MAX_REDACTIONS) {
    return {
      content: '',
      blocked: true,
      redactionCount: redactions,
      reasons: [...reasons, 'too-many-redactions'],
    };
  }

  return {content, blocked: false, redactionCount: redactions, reasons};
}

// First-name extraction from a Discord display name.
// - Picks the first whitespace-split token,
// - Strips bidi + control + emoji,
// - Caps at 24 chars,
// - Falls back to "Helper" if the result is empty.
//
// Discord already disallows handles with spaces so `username` is a
// single token; this matters more for `global_name` / server nickname.
export function extractFirstName(
  candidates: Array<string | null | undefined>,
): string {
  for (const raw of candidates) {
    if (!raw) continue;
    const first = raw.trim().split(/\s+/)[0] ?? '';
    const cleaned = first
      .replace(BIDI_RANGE, '')
      .replace(CONTROL_RANGE, '')
      // Strip most emoji (rough: ranges cover the common emoji blocks).
      .replace(
        /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F1FF}]/gu,
        '',
      )
      .trim()
      .slice(0, 24);
    if (cleaned) return cleaned;
  }
  return 'Helper';
}

// Inbound scrub for user -> Discord. Narrower than scrubForPublic:
// users legitimately share their own email / phone / order numbers
// when asking for help, so we only redact things that should never be
// in a support thread no matter who's talking (credentials, bot
// tokens, payment cards). Bidi/control chars still go.
//
// Same block-on-overload semantics as scrubForPublic: >MAX_REDACTIONS
// or >MAX_POST_SCRUB_LENGTH returns `blocked: true`, caller should
// tell the user the message was too weird to accept.

const INBOUND_PATTERNS: Pattern[] = [
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: '[token redacted]',
  },
  {
    name: 'discord-token',
    re: /\b[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g,
    replace: '[token redacted]',
  },
];

export function scrubForDiscord(raw: string): ScrubResult {
  if (!raw) {
    return {content: '', blocked: false, redactionCount: 0, reasons: []};
  }
  let content = raw;
  const reasons: string[] = [];
  let redactions = 0;

  try {
    content = content.replace(BIDI_RANGE, '');
    content = content.replace(CONTROL_RANGE, '');

    for (const p of INBOUND_PATTERNS) {
      content = content.replace(p.re, () => {
        redactions += 1;
        reasons.push(p.name);
        return p.replace;
      });
    }

    content = content.replace(CARD_RE, (match) => {
      const digits = match.replace(/[^0-9]/g, '');
      if (digits.length < 13 || digits.length > 19) return match;
      if (!luhnValid(digits)) return match;
      redactions += 1;
      reasons.push('card');
      return '[card redacted]';
    });
  } catch (err) {
    return {
      content: '',
      blocked: true,
      redactionCount: 0,
      reasons: ['scrubber-exception', String(err)],
    };
  }

  content = content.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  if (content.length > MAX_POST_SCRUB_LENGTH) {
    return {
      content: '',
      blocked: true,
      redactionCount: redactions,
      reasons: [...reasons, 'too-long'],
    };
  }
  if (redactions > MAX_REDACTIONS) {
    return {
      content: '',
      blocked: true,
      redactionCount: redactions,
      reasons: [...reasons, 'too-many-redactions'],
    };
  }
  return {content, blocked: false, redactionCount: redactions, reasons};
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}
