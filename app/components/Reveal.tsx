import {motion} from 'motion/react';
import {revealVariants, staggerContainer} from '~/lib/motion';

/**
 * Fade-and-rise an element into view the first time it enters the viewport.
 *
 * This is the JS twin of the CSS `.chapter` scroll-reveal - same curve, same
 * 16px travel - for cases where the markup isn't a `.chapter` (grids, cards,
 * arbitrary blocks). Use it sparingly and intentionally: a reveal should mark
 * a genuine new section, not fire on every paragraph.
 *
 * Reduced-motion is handled globally by <MotionConfig reducedMotion="user">,
 * which collapses the transform so these become plain (or no) fades.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  /** Stagger offset in seconds when revealing several siblings by hand. */
  delay?: number;
  as?: 'div' | 'section' | 'li' | 'article';
}) {
  const M = motion[Tag];
  return (
    <M
      className={className}
      variants={revealVariants}
      initial="hidden"
      whileInView="visible"
      viewport={{once: true, margin: '0px 0px -15% 0px'}}
      transition={{delay}}
    >
      {children}
    </M>
  );
}

/**
 * Wraps a set of `Reveal` children so they cascade in on scroll instead of
 * appearing together. Children must use `variants={revealVariants}` (the
 * default `Reveal` does) and omit their own `whileInView` - the container
 * drives them.
 */
export function RevealGroup({
  children,
  className,
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'ul';
}) {
  const M = motion[Tag];
  return (
    <M
      className={className}
      variants={staggerContainer}
      initial="hidden"
      whileInView="visible"
      viewport={{once: true, margin: '0px 0px -15% 0px'}}
    >
      {children}
    </M>
  );
}
