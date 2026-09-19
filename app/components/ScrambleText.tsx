import {useEffect, useState} from 'react';
import {useReducedMotion} from 'motion/react';

/**
 * Decode-in text: the string resolves left-to-right with a short churn of
 * technical glyphs running just ahead of the resolved prefix - a calm take
 * on the "decrypted text" effect, tuned to the site's engineering voice.
 *
 * Width only ever grows (resolved prefix + a 3-char window; nothing beyond
 * renders), so proportional headings don't jitter while decoding. The server
 * renders the full text - SEO and no-JS visitors never see the scramble -
 * and the animation starts after hydration.
 *
 * Design-brief budget: easter eggs only (the 404 SIGNAL LOST banner), not
 * regular headings.
 *
 * Reduced-motion renders the plain string; the global MotionConfig doesn't
 * cover hand-rolled RAF loops, so this checks on its own.
 */
const GLYPHS = '<>[]{}/\\|=+*#_0123456789ABCDEF';

export function ScrambleText({
  text,
  className,
  duration = 700,
  delay = 0,
}: {
  text: string;
  className?: string;
  /** Total decode time in ms. */
  duration?: number;
  /** Hold-off before the decode starts, in ms. */
  delay?: number;
}) {
  const reduceMotion = useReducedMotion();
  const [display, setDisplay] = useState(text);

  useEffect(() => {
    if (reduceMotion) {
      setDisplay(text);
      return;
    }
    let raf = 0;
    let start: number | null = null;
    const WINDOW = 3;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    const frame = (now: number) => {
      if (start === null) start = now + delay;
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      if (t >= 1) {
        setDisplay(text);
        return;
      }
      const resolved = Math.floor(easeOut(t) * text.length);
      let out = text.slice(0, resolved);
      const churn = Math.min(WINDOW, text.length - resolved);
      for (let i = 0; i < churn; i++) {
        const ch = text[resolved + i];
        out += ch === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      setDisplay(out);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [text, reduceMotion, duration, delay]);

  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{display}</span>
    </span>
  );
}
