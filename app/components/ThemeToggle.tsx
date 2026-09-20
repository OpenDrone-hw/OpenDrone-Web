import {useEffect, useState} from 'react';
import {AnimatePresence, motion} from 'motion/react';
import {DURATION, EASE} from '~/lib/motion';
import {applyTheme, getActiveTheme, type Theme} from '~/lib/theme';
import {safeStartViewTransition} from '~/lib/view-transition';

const MOON = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const SUN = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </svg>
);

/**
 * Light/dark switch. Renders the icon for the theme it will switch TO.
 *
 * The button starts in a deterministic state ('dark') so SSR and the first
 * client render agree; a mount effect then syncs it to whatever the inline
 * head script already applied (the stored choice, else dark). Until mount we
 * render aria-hidden, neutral chrome - the page is already themed correctly
 * by the head script, this only catches the toggle's own state up.
 *
 * The OS `prefers-color-scheme` is not consulted, here or in the head script:
 * dark is the default for everyone, light is an explicit choice.
 */
export function ThemeToggle({className}: {className?: string}) {
  const [theme, setTheme] = useState<Theme>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setTheme(getActiveTheme());
    setMounted(true);
  }, []);

  function toggle(e?: React.MouseEvent) {
    // Read the live theme from the DOM rather than React state - state can
    // lag the DOM by a render, which would mis-toggle on rapid clicks.
    const next: Theme = getActiveTheme() === 'dark' ? 'light' : 'dark';
    const apply = () => {
      applyTheme(next);
      setTheme(next);
    };
    // Circular reveal from the click point via the View Transitions API. The
    // new theme wipes in as an expanding circle. Falls back to an instant swap
    // where unsupported, under reduced-motion, or - critically - while another
    // transition (e.g. a React Router navigation) is already in flight: starting
    // one then would abort the other and throw
    // `InvalidStateError: Transition was aborted because of invalid state`.
    // safeStartViewTransition guards all of that, always applies the theme, and
    // never throws/rejects.
    const root = document.documentElement;
    root.style.setProperty('--vt-x', `${e?.clientX ?? window.innerWidth - 40}px`);
    root.style.setProperty('--vt-y', `${e?.clientY ?? 40}px`);
    root.classList.add('theme-vt');
    const vt = safeStartViewTransition(apply);
    if (!vt) {
      // Ran the swap directly (no transition) - drop the marker class again so
      // it can't leak into a later transition.
      root.classList.remove('theme-vt');
      return;
    }
    void Promise.resolve(vt.finished)
      .catch(() => {})
      .finally(() => root.classList.remove('theme-vt'));
  }

  const next = theme === 'dark' ? 'light' : 'dark';
  // Moon while in light mode (tap → dark), sun while in dark (tap → light).
  // Before mount, show the sun so SSR/first paint is stable.
  const showMoon = mounted && theme === 'light';

  return (
    <motion.button
      type="button"
      onClick={toggle}
      className={`theme-toggle${className ? ' ' + className : ''}`}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      suppressHydrationWarning
      whileTap={{scale: 0.88}}
    >
      {/* Crossfade + rotate the icon on toggle so the theme change is
          acknowledged. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={showMoon ? 'moon' : 'sun'}
          style={{display: 'inline-flex'}}
          initial={{rotate: -90, opacity: 0}}
          animate={{rotate: 0, opacity: 1}}
          exit={{rotate: 90, opacity: 0}}
          transition={{duration: DURATION.fast, ease: [...EASE.out]}}
        >
          {showMoon ? MOON : SUN}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
