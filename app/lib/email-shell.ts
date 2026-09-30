/**
 * The one email shell: header band, body rows, footer. Every OpenDrone mail
 * is built from it: the Shopify notification templates (scripts/shopify-
 * templates, through composeTemplate in gen.mjs), the Worker mails and the
 * Resend scripts. Edit the look here and nowhere else.
 *
 * Design: dark canvas (#0a0a0a) with a white header band so the black and
 * gold wordmark reads in every client. Colours are written as bgcolor
 * attributes as well as inline styles, so clients that strip style rules
 * still show the dark card. The mail is dark by design, not by inversion:
 * `color-scheme: dark` tells Apple Mail and Outlook not to re-invert it.
 * The wordmark carries alt text in dark ink on the white band for clients
 * that block images. A small media query tightens padding on phones.
 *
 * Imported by node:test and by plain node scripts (type stripping), so:
 * relative imports with extensions, no enums, no parameter properties.
 * Values passed to the builders are HTML: escape user input with escapeHtml.
 */

export const SITE = 'https://opendrone.be';
export const WORDMARK =
  'https://cdn.shopify.com/s/files/1/1032/6641/9033/files/opendrone-wordmark-email-blackgold_39eb37d0-777f-4a31-b2f3-eb25965c97d7.png?v=1786703416';
export const COMPANY_LINE =
  'Incutec BV · Stapelhuisstraat 15, 3000 Leuven, Belgium · KBO 1038.934.039 · BTW BE 1038.934.039';
export const COMPANY_LINE_TEXT =
  'Incutec BV, Stapelhuisstraat 15, 3000 Leuven, Belgium. KBO 1038.934.039. BTW BE 1038.934.039';

const MONO = "'JetBrains Mono', 'Courier New', monospace";
const HEAD = "'Space Grotesk', Helvetica, Arial, sans-serif";
const BODY = 'Helvetica, Arial, sans-serif';

export const COLOR = {
  canvas: '#0a0a0a',
  card: '#101210',
  line: '#1a241a',
  accent: '#ffb700',
  text: '#e5e5e5',
  body: '#c5c5c5',
  muted: '#a0a0a0',
} as const;

/**
 * Campaign facts that mail prose repeats. They must equal content/preorders.json
 * (endsOn, shipsBy of the preorder-run SKUs and the
 * paid batch's `ships` wording); app/lib/email-shell.test.ts fails when they differ. Bodies and builders write the
 * tokens (%%CLOSE%% and so on) and applyFacts fills them.
 */
export const FACTS = {
  closeIso: '2026-12-15',
  close: '15 December 2026',
  shipBy: '31 March 2027',
  batch1: 'early November',
} as const;

const FACT_TOKENS: Record<string, string> = {
  '%%CLOSE%%': FACTS.close,
  '%%SHIPBY%%': FACTS.shipBy,
  '%%BATCH1%%': FACTS.batch1,
};

export function applyFacts(src: string): string {
  let out = src;
  for (const [token, value] of Object.entries(FACT_TOKENS)) out = out.replaceAll(token, value);
  if (/%%[A-Z0-9_]+%%/.test(out)) throw new Error(`email-shell: unknown fact token ${/%%[A-Z0-9_]+%%/.exec(out)?.[0]}`);
  return out;
}

export function escapeHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type Tone = 'text' | 'body' | 'muted' | 'accent';

const toneColor = (tone: Tone | undefined, fallback: Tone): string => COLOR[tone ?? fallback];

/** Kicker line plus the big heading. */
export function head(kicker: string, title: string): string {
  return `            <tr>
              <td class="od-px" style="padding: 40px 32px 0 32px;">
                <p style="margin: 0 0 14px 0; font-family: ${MONO}; font-size: 13px; letter-spacing: 0.2em; text-transform: uppercase; color: ${COLOR.accent};">
                  ${kicker}
                </p>
                <h1 class="od-h1" style="margin: 0 0 20px 0; font-family: ${HEAD}; font-size: 32px; line-height: 1.15; font-weight: 700; letter-spacing: -0.01em; color: ${COLOR.text};">
                  ${title}
                </h1>
              </td>
            </tr>
`;
}

/** A paragraph row. `small` is 14px, default 16px. */
export function para(html: string, opts: {tone?: Tone; small?: boolean; last?: boolean} = {}): string {
  const size = opts.small ? 14 : 16;
  return `            <tr>
              <td class="od-px" style="padding: 0 32px ${opts.last ? 28 : 16}px 32px;">
                <p style="margin: 0; font-family: ${BODY}; font-size: ${size}px; line-height: 1.6; color: ${toneColor(opts.tone, opts.small ? 'muted' : 'body')};">
                  ${html}
                </p>
              </td>
            </tr>
`;
}

/** A paragraph inside a card or note. */
export function text(html: string, opts: {tone?: Tone; small?: boolean; last?: boolean} = {}): string {
  return `<p style="margin: 0 0 ${opts.last ? 0 : 8}px 0; font-family: ${BODY}; font-size: ${opts.small ? 13 : 14}px; line-height: 1.6; color: ${toneColor(opts.tone, 'body')};">${html}</p>`;
}

/** Small mono caps label. */
export function label(html: string, tone: Tone = 'muted'): string {
  return `<p style="margin: 0 0 10px 0; font-family: ${MONO}; font-size: 12px; letter-spacing: 0.15em; text-transform: uppercase; color: ${toneColor(tone, 'muted')};">${html}</p>`;
}

/** Bordered box. `accent` gives the gold border used for preorder promises. */
export function card(inner: string, opts: {accent?: boolean} = {}): string {
  return `            <tr>
              <td class="od-px" style="padding: 0 32px 28px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.canvas}" style="background-color: ${COLOR.canvas}; border: 1px solid ${opts.accent ? COLOR.accent : COLOR.line};">
                  <tr>
                    <td style="padding: 20px 24px;">
                      ${inner}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
`;
}

/** Gold call-to-action button. */
export function button(href: string, labelHtml: string, opts: {last?: boolean} = {}): string {
  return `            <tr>
              <td class="od-px" style="padding: 0 32px ${opts.last === false ? 24 : 36}px 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="${COLOR.accent}" style="background-color: ${COLOR.accent}; border-radius: 4px;">
                      <a href="${href}" style="display: inline-block; padding: 14px 28px; font-family: ${MONO}; font-size: 13px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: ${COLOR.canvas}; text-decoration: none;">
                        ${labelHtml}
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
`;
}

/** Key/value rows for a card ("Cadence  Monthly"). */
export function keyValues(rows: Array<[string, string]>): string {
  const cells = rows
    .map(
      ([k, v]) => `<tr>
                          <td valign="top" style="padding: 4px 12px 4px 0; width: 120px; font-family: ${MONO}; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: ${COLOR.muted};">${k}</td>
                          <td valign="top" style="padding: 4px 0; font-family: ${MONO}; font-size: 12px; color: ${COLOR.body};">${v}</td>
                        </tr>`,
    )
    .join('\n                        ');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        ${cells}
                      </table>`;
}

export function rule(): string {
  return `            <tr>
              <td class="od-px" style="padding: 0 32px 24px 32px;">
                <div style="border-top: 1px solid ${COLOR.line}; font-size: 1px; line-height: 1px;">&nbsp;</div>
              </td>
            </tr>
`;
}

export type ShellOptions = {
  title: string;
  badge: string;
  preheader: string;
  /** Body rows: <tr> elements built with head/para/card/button or raw. */
  body: string;
  /** Extra footer line HTML, e.g. an unsubscribe sentence. Optional. */
  footerNote?: string;
  /** HTML appended after the opendrone.be link (Shopify unsubscribe link). */
  footerLinks?: string;
  lang?: string;
};

/** The whole document. */
export function shell(o: ShellOptions): string {
  return `<!DOCTYPE html>
<html lang="${o.lang ?? 'en'}" style="color-scheme: dark;">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="dark" />
    <meta name="supported-color-schemes" content="dark" />
    <title>${o.title}</title>
    <style>
      :root { color-scheme: dark; supported-color-schemes: dark; }
      a { color: ${COLOR.accent}; }
      @media only screen and (max-width: 480px) {
        .od-outer { padding: 16px 8px !important; }
        .od-px { padding-left: 20px !important; padding-right: 20px !important; }
        .od-h1 { font-size: 26px !important; }
      }
    </style>
  </head>
  <body
    bgcolor="${COLOR.canvas}"
    style="margin: 0; padding: 0; background-color: ${COLOR.canvas}; color: ${COLOR.text}; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; -webkit-text-size-adjust: 100%;"
  >
    <div style="display: none; max-height: 0; overflow: hidden; font-size: 1px; line-height: 1px; color: ${COLOR.canvas}; opacity: 0;">
      ${o.preheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.canvas}" style="background-color: ${COLOR.canvas};">
      <tr>
        <td class="od-outer" align="center" style="padding: 32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLOR.card}" style="width: 100%; max-width: 600px; background-color: ${COLOR.card}; border: 1px solid ${COLOR.line};">
            <!-- HEADER: white band so the black and gold wordmark reads in every client. -->
            <tr>
              <td class="od-px" bgcolor="#ffffff" style="padding: 18px 32px; background-color: #ffffff;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="font-family: ${HEAD}; font-size: 20px; font-weight: 700; color: ${COLOR.canvas};">
                      <img src="${WORDMARK}" alt="OpenDrone" width="160" height="39" style="display: block; border: 0; outline: none; text-decoration: none; height: 39px; width: 160px; font-family: ${HEAD}; font-size: 20px; font-weight: 700; color: ${COLOR.canvas};" />
                    </td>
                    <td align="right" style="font-family: ${MONO}; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase; color: #4a4a4a;">
                      ${o.badge}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- BODY -->
${o.body}
            <!-- FOOTER -->
            <tr>
              <td class="od-px" style="padding: 24px 32px; border-top: 1px solid ${COLOR.line}; font-family: ${BODY}; font-size: 12px; line-height: 1.6; color: ${COLOR.muted};">${
                o.footerNote
                  ? `
                <p style="margin: 0 0 12px 0;">${o.footerNote}</p>`
                  : ''
              }
                <p style="margin: 0 0 12px 0;">
                  OpenDrone &middot; open source drone electronics designed in Belgium.
                </p>
                <p style="margin: 0 0 16px 0;">
                  ${COMPANY_LINE.replaceAll('&', '&amp;')}
                </p>
                <p style="margin: 0; font-family: ${MONO}; font-size: 12px; letter-spacing: 0.1em;">
                  <a href="${SITE}" style="color: ${COLOR.accent}; text-decoration: none;">opendrone.be</a>${o.footerLinks ?? ''}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

// --- Body macros -------------------------------------------------------------
//
// Shopify bodies are hand-written HTML with Liquid. Repeating the inline-styled
// row markup in every body is how the old templates drifted, so bodies use
// these tags instead and composeTemplate expands them from the builders above:
//
//   <od-head kicker="Order {{ name }}">Thanks.</od-head>
//   <od-p>Text</od-p>   <od-p small>..</od-p>   <od-p tone="accent">..</od-p>
//   <od-button href="{{ order_status_url }}">View order &rarr;</od-button>
//   <od-card accent> <od-label>Preorder</od-label> <od-t>text</od-t> </od-card>
//   <od-kv>Cadence|Monthly;;Content|Notes</od-kv>
//   <od-rule />
//
// Attribute values are double quoted and may hold Liquid with single quotes.

const TAG = /<od-([a-z]+)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*(?:\/>|>([\s\S]*?)<\/od-\1>)/;

function parseAttrs(src: string): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (const m of src.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? true;
  return out;
}

function expandOne(name: string, attrs: Record<string, string | true>, inner: string): string {
  const inside = inner.trim();
  const tone = typeof attrs.tone === 'string' ? (attrs.tone as Tone) : undefined;
  switch (name) {
    case 'head':
      return head(String(attrs.kicker ?? ''), inside);
    case 'p':
      return para(inside, {tone, small: attrs.small === true, last: attrs.last === true});
    case 't':
      return text(inside, {tone, small: attrs.small === true, last: attrs.last === true});
    case 'label':
      return label(inside, tone ?? 'muted');
    case 'card':
      return card(inside, {accent: attrs.accent === true});
    case 'button':
      return button(String(attrs.href ?? ''), inside, {last: attrs.more === true ? false : true});
    case 'kv':
      return keyValues(inside.split(';;').map((r) => r.split('|').map((s) => s.trim()) as [string, string]));
    case 'rule':
      return rule();
    default:
      throw new Error(`email-shell: unknown macro <od-${name}>`);
  }
}

/** Expand <od-*> macros: inline pieces first, so cards can hold them. */
export function expandMacros(body: string): string {
  let out = body.replace(
    /<od-(label|t|kv)((?:\s+[a-z-]+(?:="[^"]*")?)*)\s*>([\s\S]*?)<\/od-\1>/g,
    (_m, name: string, attrs: string, inner: string) => expandOne(name, parseAttrs(attrs), inner),
  );
  for (let m = TAG.exec(out); m; m = TAG.exec(out)) {
    out = out.slice(0, m.index) + expandOne(m[1], parseAttrs(m[2]), m[3] ?? '') + out.slice(m.index + m[0].length);
  }
  if (/<od-/.test(out)) throw new Error('email-shell: unexpanded <od-*> macro left in body');
  return out;
}
