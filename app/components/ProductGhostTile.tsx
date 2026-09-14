/**
 * Engineering-document ghost tile for products that don't have photography
 * yet. Instead of a grey word in a box, the empty media slot reads as a
 * catalog figure: hairline-ruled header with the product type, a technical
 * line glyph (same stroke language as the PDP chapter placeholders), and
 * the product title as the catalog line. Tokens only — works in both
 * themes. Purely decorative: the card's text body carries the real info,
 * so the whole tile is aria-hidden.
 */

import type {ReactNode} from 'react';

/** Line glyphs in the ChapterMediaPlaceholder stroke style
 *  (120-viewBox, 1.2 hairline, round caps). Picked deterministically from
 *  the title so a given product always shows the same figure. */
const GLYPHS: ReactNode[] = [
  // 00 — isometric crate (boxed part)
  <g key="crate">
    <path d="M24 38l36-14 36 14v44L60 96 24 82z" />
    <path d="M24 38l36 14 36-14" />
    <path d="M60 52v44" />
  </g>,
  // 01 — fastener head, slotted
  <g key="fastener">
    <circle cx="60" cy="60" r="32" />
    <circle cx="60" cy="60" r="22" />
    <path d="M44 60h32" />
    <path d="M60 24v8M60 88v8M24 60h8M88 60h8" />
  </g>,
  // 02 — cable with connectors
  <g key="cable">
    <rect x="22" y="50" width="16" height="20" rx="2" />
    <rect x="82" y="50" width="16" height="20" rx="2" />
    <path d="M38 60c8 0 8-14 16-14s6 28 14 28 6-14 14-14" />
    <path d="M26 56v-6M34 56v-6M86 56v-6M94 56v-6" />
  </g>,
];

function glyphIndex(seed: string): number {
  let sum = 0;
  for (let i = 0; i < seed.length; i++) sum = (sum + seed.charCodeAt(i)) % 997;
  return sum % GLYPHS.length;
}

export function ProductGhostTile({
  type,
  title,
}: {
  /** Product type ("Accessory", "Flight controller", …) — the document
   *  header. Falls back to the brand when the product has no family. */
  type?: string | null;
  /** Product title — rendered as the catalog line under the figure. */
  title: string;
}) {
  const idx = glyphIndex(title);
  return (
    <div className="ghost-tile" aria-hidden="true">
      <div className="ghost-tile-rule">
        <span className="ghost-tile-type">{type || 'OpenDrone'}</span>
        <span className="ghost-tile-fig">Fig. —</span>
      </div>
      <div className="ghost-tile-figure">
        <svg
          viewBox="0 0 120 120"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {GLYPHS[idx]}
        </svg>
      </div>
      <div className="ghost-tile-rule is-foot">
        <span className="ghost-tile-catalog">{title}</span>
      </div>
    </div>
  );
}
