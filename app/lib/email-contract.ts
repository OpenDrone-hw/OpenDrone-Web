import {readFileSync} from 'node:fs';
import {marked} from 'marked';
import {COLOR, SITE, escapeHtml} from './email-shell.ts';
import {LEGAL_GUARANTEE_NOTICE} from './legal-guarantee-notice.ts';

const DOCUMENTS = [
  'algemene-voorwaarden',
  'herroepingsformulier',
  'warranty',
  'end-use-policy',
] as const;

function documentHtml(slug: typeof DOCUMENTS[number]): string {
  const source = readFileSync(new URL(`../content/legal/en/${slug}.md`, import.meta.url), 'utf8');
  const renderer = new marked.Renderer();
  renderer.html = ({text}) => escapeHtml(text);
  const literalForm = source
    .replace(/\(\*\)/g, '(&#42;)')
    .replace(/_{3,}/g, (blank) => '&#95;'.repeat(blank.length));
  const html = marked.parse(literalForm, {async: false, breaks: true, renderer});

  return html
    .replace(/<h([1-6])>/g, (_match, level: string) =>
      `<h${level} style="margin: 20px 0 8px; font-size: ${Number(level) < 3 ? 18 : 14}px; line-height: 1.4; color: ${COLOR.text};">`,
    )
    .replace(/<p>/g, '<p style="margin: 0 0 10px;">')
    .replace(/<([ou])l>/g, '<$1l style="margin: 0 0 10px; padding-left: 20px;">')
    .replace(/<li>/g, '<li style="margin: 0 0 4px;">')
    .replace(/<hr\s*\/?>/g, `<hr style="border: 0; border-top: 1px solid ${COLOR.line}; margin: 16px 0;" />`)
    .replace(/<table>/g, '<table width="100%" cellpadding="0" cellspacing="0" style="width: 100%; table-layout: fixed; border-collapse: collapse; margin: 0 0 12px;">')
    .replace(/<(t[dh])>/g, '<$1 style="text-align: left; vertical-align: top; padding: 4px; overflow-wrap: anywhere;">')
    .replace(/<a href="([^"]+)"/g, (_match, href: string) => {
      const absolute = href.startsWith('/') ? `${SITE}${href}` : href;
      if (!/^(https?:\/\/|mailto:|tel:|#)/i.test(absolute)) {
        throw new Error(`email-contract: unsupported link in ${slug}`);
      }
      return `<a href="${absolute}" style="color: ${COLOR.accent}; text-decoration: underline; overflow-wrap: anywhere;"`;
    });
}

/** Build-time copy of the legal sources, stored in the delivered email. */
export function renderEmailContract(): string {
  const notice = LEGAL_GUARANTEE_NOTICE.en;
  const noticeText = notice.text.map((paragraph) =>
    `<p style="margin: 0 0 10px;">${escapeHtml(paragraph)}</p>`,
  ).join('\n');

  return `<tr>
  <td class="od-px" style="padding: 0 32px 24px;">
    <div style="border-top: 1px solid ${COLOR.line}; padding-top: 16px; font-family: Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.5; color: ${COLOR.body}; word-wrap: break-word; overflow-wrap: anywhere;">
      <h2 style="margin: 0 0 8px; font-size: 18px; color: ${COLOR.text};">Your contract documents</h2>
      <p style="margin: 0 0 16px;">Keep this email with your order details. The terms, withdrawal instructions and model form, warranty information and end-use policy are included below.</p>
      {% if shipping_address == blank or eu_countries contains shipping_address.country_code %}
      <h3 style="margin: 16px 0 8px; font-size: 14px; color: ${COLOR.text};">${escapeHtml(notice.title)}</h3>
      <a href="${SITE}${notice.assetPath}" style="color: ${COLOR.accent};">
        <img src="${SITE}${notice.assetPath}" alt="${escapeHtml(notice.image)}" width="536" style="display: block; width: 100%; max-width: 536px; height: auto; border: 0; margin: 0 0 12px;" />
      </a>
      ${noticeText}
      <p style="margin: 0 0 16px;"><a href="${notice.url}" style="color: ${COLOR.accent}; text-decoration: underline;">${escapeHtml(notice.more)}</a></p>
      {% endif %}
      ${DOCUMENTS.map(documentHtml).join('\n')}
    </div>
  </td>
</tr>`;
}
