/**
 * Load + render legal Markdown snapshots from app/content/legal/.
 *
 * Uses Vite's ?raw import so the Markdown is bundled at build time and
 * available in Oxygen's edge runtime (no fs access). A small Markdown →
 * HTML converter handles headings, paragraphs, lists, blockquotes, tables,
 * bold/italic, inline code, and links. This avoids pulling in a full
 * Markdown parser dep and matches the existing .rich-content styling.
 *
 * The compliance Markdown files contain editorial annotations (front-matter
 * style notes, "Implementation Checklist" sections). Everything before the
 * first `---` separator and after `## Implementation Checklist` / `## Source`
 * / `## Notes` headings is stripped so only the customer-facing body is
 * rendered.
 */

// NL = authoritative text synced from the compliance repo via scripts/sync-legal.mjs.
// EN = hand-authored translations, stored in the webshop repo.
// When a new legal language is added later (FR/DE), mirror this pattern:
// add a new directory under app/content/legal/<lang>/ and a new SOURCES_<lang> map.
import algemeneVoorwaardenNl from '~/content/legal/nl/algemene-voorwaarden.md?raw';
import privacyPolicyNl from '~/content/legal/nl/privacy-policy.md?raw';
import cookiePolicyNl from '~/content/legal/nl/cookie-policy.md?raw';
import herroepingNl from '~/content/legal/nl/herroepingsformulier.md?raw';
import vulnPolicyNl from '~/content/legal/nl/vulnerability-handling-policy.md?raw';
import warrantyNl from '~/content/legal/nl/warranty.md?raw';
import shippingNl from '~/content/legal/nl/shipping.md?raw';
import endUseNl from '~/content/legal/nl/end-use-policy.md?raw';

import algemeneVoorwaardenFr from '~/content/legal/fr/algemene-voorwaarden.md?raw';
import privacyPolicyFr from '~/content/legal/fr/privacy-policy.md?raw';
import cookiePolicyFr from '~/content/legal/fr/cookie-policy.md?raw';
import herroepingFr from '~/content/legal/fr/herroepingsformulier.md?raw';
import vulnPolicyFr from '~/content/legal/fr/vulnerability-handling-policy.md?raw';
import warrantyFr from '~/content/legal/fr/warranty.md?raw';
import shippingFr from '~/content/legal/fr/shipping.md?raw';
import endUseFr from '~/content/legal/fr/end-use-policy.md?raw';

import algemeneVoorwaardenEn from '~/content/legal/en/algemene-voorwaarden.md?raw';
import privacyPolicyEn from '~/content/legal/en/privacy-policy.md?raw';
import cookiePolicyEn from '~/content/legal/en/cookie-policy.md?raw';
import herroepingEn from '~/content/legal/en/herroepingsformulier.md?raw';
import vulnPolicyEn from '~/content/legal/en/vulnerability-handling-policy.md?raw';
import warrantyEn from '~/content/legal/en/warranty.md?raw';
import shippingEn from '~/content/legal/en/shipping.md?raw';
import endUseEn from '~/content/legal/en/end-use-policy.md?raw';

export type LegalSlug =
  | 'algemene-voorwaarden'
  | 'privacy-policy'
  | 'cookie-policy'
  | 'herroepingsformulier'
  | 'vulnerability-handling-policy'
  | 'warranty'
  | 'shipping'
  | 'end-use-policy';

const SOURCES_NL: Record<LegalSlug, string> = {
  'algemene-voorwaarden': algemeneVoorwaardenNl,
  'privacy-policy': privacyPolicyNl,
  'cookie-policy': cookiePolicyNl,
  herroepingsformulier: herroepingNl,
  'vulnerability-handling-policy': vulnPolicyNl,
  warranty: warrantyNl,
  shipping: shippingNl,
  'end-use-policy': endUseNl,
};

const SOURCES_EN: Record<LegalSlug, string> = {
  'algemene-voorwaarden': algemeneVoorwaardenEn,
  'privacy-policy': privacyPolicyEn,
  'cookie-policy': cookiePolicyEn,
  herroepingsformulier: herroepingEn,
  'vulnerability-handling-policy': vulnPolicyEn,
  warranty: warrantyEn,
  shipping: shippingEn,
  'end-use-policy': endUseEn,
};

const SOURCES_FR: Record<LegalSlug, string> = {
  'algemene-voorwaarden': algemeneVoorwaardenFr,
  'privacy-policy': privacyPolicyFr,
  'cookie-policy': cookiePolicyFr,
  herroepingsformulier: herroepingFr,
  'vulnerability-handling-policy': vulnPolicyFr,
  warranty: warrantyFr,
  shipping: shippingFr,
  'end-use-policy': endUseFr,
};

const STRIP_SECTIONS = [
  'Implementation Checklist',
  'Implementation checklist',
  'Source',
  'Sources',
  'Notes',
  'Internal notes',
  'Incutec-Specific Analysis',
];

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only these schemes are allowed inside Markdown link targets. Anything
// else (javascript:, data:, vbscript:, file:, etc.) falls back to plain
// text so a malformed / malicious entry in a committed .md file can't
// produce a dangerous <a href>. Legal copy is authored in-repo but
// defensive validation is cheap insurance for an open-source project.
const SAFE_LINK_RE =
  /^(?:https?:\/\/|mailto:|tel:|\/|#)[^\s"<>]*$/i;

function inline(s: string) {
  // bold, italic, inline code, images, links
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // The model withdrawal form marks "delete as appropriate" with a literal
  // "(*)"; keep it out of the emphasis rules below.
  out = out.replace(/\(\*\)/g, '(&#42;)');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Images before links: `![alt](src)` is a link pattern with a `!` in
  // front, so the link rule would eat it and leave a stray bang. Same
  // href allowlist, so a malformed src degrades to its alt text.
  out = out.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_m, alt: string, src: string) => {
      const t = src.trim();
      if (!SAFE_LINK_RE.test(t)) return alt;
      return `<img src="${t}" alt="${alt}" loading="lazy" decoding="async" />`;
    },
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text: string, href: string) => {
      const t = href.trim();
      if (!SAFE_LINK_RE.test(t)) return text;
      return `<a href="${t}" rel="noopener">${text}</a>`;
    },
  );
  return out;
}

/**
 * Minimal, purposely-limited Markdown → HTML converter. Supports:
 * headings, paragraphs, ordered/unordered lists, blockquotes, simple
 * pipe tables, horizontal rules, and inline bold/italic/code/images/links.
 * Not a general-purpose MD parser - tuned to the compliance documents and
 * the newsletter posts (app/lib/posts.ts).
 */
export function mdToHtml(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // table (must have header row + separator row)
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /\|/.test(lines[i + 1])) {
      const header = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i])) {
        const row = lines[i]
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
        rows.push(row);
        i++;
      }
      const headHtml = header.map((c) => `<th>${inline(c)}</th>`).join('');
      const bodyHtml = rows
        .map(
          (r) =>
            `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`,
        )
        .join('');
      out.push(
        `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
      );
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraph (collect consecutive non-blank lines that don't start a block)
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/**
 * Strip editorial sections. Keeps only the customer-facing portion of a
 * compliance markdown file.
 */
function cleanSource(src: string): string {
  let working = src;

  // Remove everything above the first `---` separator iff the first heading
  // appears after it (indicates editorial preamble).
  const firstHr = working.indexOf('\n---');
  const firstHeading = working.indexOf('\n## ');
  if (firstHr > -1 && firstHeading > firstHr) {
    working = working.slice(firstHr + 4);
  }

  // Cut at the earliest stripped-section heading, regardless of which
  // marker name matches first. Previously this loop broke on the first
  // name in STRIP_SECTIONS that matched anywhere in the document, which
  // meant a `## Sources` heading at the bottom of a file could win over
  // a `## Notes` heading higher up and leak internal content.
  let cutAt = -1;
  for (const name of STRIP_SECTIONS) {
    const re = new RegExp(`\\n##+\\s+${name}\\b`, 'i');
    const m = re.exec(working);
    if (m && (cutAt === -1 || m.index < cutAt)) {
      cutAt = m.index;
    }
  }
  if (cutAt !== -1) {
    working = working.slice(0, cutAt);
  }

  return working.trim();
}

/**
 * Render a legal page to HTML for a given locale.
 * The Dutch version is legally authoritative for consumers residing in
 * Belgium; the English version is informative only. Both are bundled at
 * build time via Vite's `?raw` imports so they work on Oxygen's edge
 * runtime without filesystem access.
 */
export function loadLegal(
  slug: LegalSlug,
  locale: 'en' | 'nl' | 'fr',
): string {
  const src =
    locale === 'nl'
      ? SOURCES_NL[slug]
      : locale === 'fr'
        ? SOURCES_FR[slug]
        : SOURCES_EN[slug];
  return mdToHtml(cleanSource(src));
}
