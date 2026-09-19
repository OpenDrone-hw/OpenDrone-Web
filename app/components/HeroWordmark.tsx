import {useMemo} from 'react';
import {
  WORDMARK_GROUP_TRANSFORM,
  WORDMARK_LETTERS,
  WORDMARK_VIEWBOX,
} from '~/data/wordmark';

/**
 * Hero wordmark with two phases:
 *
 * 1. **Draw** (0..~700ms per letter, staggered) - each letter "flies in"
 *    from a small random offset while its stroke is drawn via
 *    `stroke-dashoffset` on `pathLength="100"`. Pure CSS.
 *
 * 2. **Fill** (driven by `progress`) - each letter fades from outline to
 *    solid color individually as the load progresses. The first letter
 *    fills when progress crosses ~0/N, the last when it crosses ~(N-1)/N,
 *    with a small ramp width per letter so the transition is smooth, not
 *    snap-to-on.
 *
 * `prefers-reduced-motion` skips Phase 1 and jumps to the filled state.
 */
export function HeroWordmark({
  progress,
  className,
}: {
  /** 0..1. Parent decides whether this is real GLTFLoader byte progress,
   *  a synthetic time-based ramp, or a JS-lerped smoothing of either. */
  progress: number;
  className?: string;
}) {
  // Per-letter "fly-in" offset for the wireframe phase. Memoised so the
  // offset stays stable across re-renders during the draw animation.
  // Deterministic (sine-hash on index) so SSR and client agree. Magnitudes
  // floored so no letter happens to seed near 0.5 and spawn in-place -
  // every letter must visibly assemble.
  const letterStyles = useMemo(() => {
    return WORDMARK_LETTERS.map(({index}) => {
      const seed = Math.sin(index * 12.9898) * 43758.5453;
      const a = seed - Math.floor(seed);
      const b = Math.sin(index * 78.233) * 43758.5453;
      const c = b - Math.floor(b);
      // Signed jitter with a magnitude floor - even an `a` near 0.5
      // yields a meaningful displacement. dx ±(120..280)px,
      // dy ±(60..160)px, rot ±(8..28)deg.
      const signA = a < 0.5 ? -1 : 1;
      const signC = c < 0.5 ? -1 : 1;
      const magA = Math.abs(a - 0.5) * 2; // 0..1
      const magC = Math.abs(c - 0.5) * 2;
      const dx = signA * (120 + magA * 160);
      const dy = signC * (60 + magC * 100);
      const rot = signA * (8 + magA * 20);
      return {
        '--dx': `${dx.toFixed(1)}px`,
        '--dy': `${dy.toFixed(1)}px`,
        '--rot': `${rot.toFixed(1)}deg`,
        '--letter-index': String(index),
      } as React.CSSProperties;
    });
  }, []);

  const clamped = Math.max(0, Math.min(1, progress));
  const N = WORDMARK_LETTERS.length;

  // Per-letter fill opacity. Letter i starts filling when `progress`
  // crosses `start(i)` and reaches full at `start(i) + RAMP_WIDTH`.
  // Thresholds are spaced so letter 0 starts at 0 and letter N-1
  // finishes at exactly progress=1. RAMP_WIDTH > 1/N means adjacent
  // letters overlap, so the wave reads as continuous rather than a
  // beaded sequence of pop-ins.
  const RAMP_WIDTH = 0.42;
  const spacing = N > 1 ? (1 - RAMP_WIDTH) / (N - 1) : 0;

  const fillOpacityFor = (i: number) => {
    const threshold = i * spacing;
    return Math.max(0, Math.min(1, (clamped - threshold) / RAMP_WIDTH));
  };

  return (
    <svg
      className={`hero-wordmark-svg${className ? ' ' + className : ''}`}
      viewBox={WORDMARK_VIEWBOX}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="OpenDrone"
    >
      {/*
        Outer wrapper carries the potrace group transform (y-flip + 0.1
        scale). Inside, paths live in the original potrace coord system
        which is ~10x the displayed size - vector-effect on strokes
        keeps stroke-width in viewport pixels regardless of that scale.
      */}
      <g transform={WORDMARK_GROUP_TRANSFORM}>
        {/*
          Stroke layer - drawn first so the fill layer paints on top.
          Each path uses pathLength="100" so a single
          stroke-dashoffset:100→0 keyframe works regardless of the
          actual geometric length. CSS reads --fill-opacity to fade
          the stroke as the fill rises.
        */}
        <g className="hw-strokes">
          {WORDMARK_LETTERS.map((letter, i) => {
            const f = fillOpacityFor(i);
            return (
              <path
                key={`s-${letter.index}`}
                className={`hw-stroke hw-stroke--${letter.group}`}
                data-char={letter.ch}
                d={letter.d}
                pathLength={100}
                vectorEffect="non-scaling-stroke"
                style={{
                  ...letterStyles[i],
                  ['--fill-opacity' as any]: f,
                }}
              />
            );
          })}
        </g>

        {/*
          Fill layer - same paths, fill only. Per-letter opacity driven
          by `progress`. evenodd so counters (the hole in O/p/o/D) cut
          through the outer shape correctly.
        */}
        <g className="hw-fills" fillRule="evenodd">
          {WORDMARK_LETTERS.map((letter, i) => (
            <path
              key={`f-${letter.index}`}
              className={`hw-fill hw-fill--${letter.group}`}
              data-char={letter.ch}
              d={letter.d}
              style={{
                ...letterStyles[i],
                opacity: fillOpacityFor(i),
              }}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
