import {motion} from 'motion/react';
import {popOpen} from '~/lib/motion';

/**
 * The shared floating-surface primitive. Every dropdown panel, the hero
 * product showcase, and the PDP scroll-bubble render as a `<Pod>` so they're
 * the same material (the `.pod` token recipe) and move with the same
 * `popOpen` expand-from-origin motion. The header pill and frame slider apply
 * the `.pod` tokens directly rather than through this component.
 *
 * `animate` makes it a Motion element that expands open (use inside
 * <AnimatePresence> for exit). `origin` sets transform-origin so it grows from
 * the trigger. Reduced-motion is handled globally by <MotionConfig>.
 */
export function Pod({
  children,
  className,
  pill = false,
  strong = false,
  animate = false,
  origin = 'top center',
  role,
  ariaLabel,
}: {
  children: React.ReactNode;
  className?: string;
  pill?: boolean;
  strong?: boolean;
  animate?: boolean;
  origin?: string;
  role?: string;
  ariaLabel?: string;
}) {
  const cls = `pod${pill ? ' pod--pill' : ''}${strong ? ' pod--strong' : ''}${
    className ? ' ' + className : ''
  }`;

  if (!animate) {
    return (
      <div className={cls} role={role} aria-label={ariaLabel}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      className={cls}
      role={role}
      aria-label={ariaLabel}
      style={{transformOrigin: origin}}
      variants={popOpen}
      initial="closed"
      animate="open"
      exit="exit"
    >
      {children}
    </motion.div>
  );
}
