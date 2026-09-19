import {
  WORDMARK_GROUP_TRANSFORM,
  WORDMARK_LETTERS,
  WORDMARK_VIEWBOX,
} from '~/data/wordmark';

/**
 * Static, theme-aware OpenDrone wordmark for site chrome (header).
 *
 * Same traced paths as the animated HeroWordmark, but rendered as a flat
 * filled logo: "Open" in the body text color, "Drone" in gold - both via
 * tokens, so it inverts correctly in light mode. Replaces the white-baked
 * PNG that vanished on a light background.
 */
export function SiteWordmark({className}: {className?: string}) {
  return (
    <svg
      className={className}
      viewBox={WORDMARK_VIEWBOX}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="OpenDrone"
    >
      <g transform={WORDMARK_GROUP_TRANSFORM} fillRule="evenodd">
        {(() => {
          let goldIdx = 0;
          return WORDMARK_LETTERS.map((letter) => {
            const isGold = letter.group === 'drone';
            if (!isGold) {
              return (
                <path
                  key={letter.index}
                  d={letter.d}
                  fill="var(--color-text)"
                />
              );
            }
            // Each gold letter is a static base path plus a brighter overlay
            // copy whose opacity is animated (the ambient sheen). Animating the
            // overlay's opacity - a compositor-only property - keeps the wave on
            // the GPU instead of repainting the glyph every frame the way the
            // old `fill` animation did. The per-letter --gold-index staggers the
            // sweep into a left→right wave.
            const goldStyle = {
              '--gold-index': goldIdx++,
            } as React.CSSProperties;
            return (
              <g key={letter.index}>
                <path d={letter.d} fill="var(--color-gold-fill)" />
                <path
                  className="site-wordmark-sheen"
                  style={goldStyle}
                  d={letter.d}
                  fill="color-mix(in srgb, var(--color-gold-fill) 55%, white)"
                />
              </g>
            );
          });
        })()}
      </g>
    </svg>
  );
}
