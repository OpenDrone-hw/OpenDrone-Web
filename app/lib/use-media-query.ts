import {useSyncExternalStore} from 'react';

/**
 * Canonical breakpoint system for the whole site. One source of truth so the
 * scattered ad-hoc `matchMedia('(max-width: 768px)')` / 900 / 959 / 1024 / 1025
 * literals can converge here over time. Mobile-first: a breakpoint is the
 * min-width at which that tier begins.
 *
 *   phone   0      – 639   (single column, touch-first)
 *   sm      640    – 767   (large phone / small tablet portrait)
 *   md      768    – 1023  (tablet)
 *   lg      1024   – 1279  (small laptop - desktop hero turns on here)
 *   xl      1280+         (wide)
 *
 * `MOBILE_MAX` is the shared "below this is the touch experience" cutoff used
 * by the home hero gate, the board explorer, etc. Keep it aligned with the CSS
 * `@media (max-width: 1023px)` mobile blocks.
 */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type Breakpoint = keyof typeof BREAKPOINTS;

/** The largest viewport that still gets the mobile/touch experience. */
export const MOBILE_MAX = BREAKPOINTS.lg - 1; // 1023

/**
 * SSR-safe `matchMedia` subscription. Returns `serverFallback` during SSR and
 * the first client render (so hydration matches the server), then the live
 * value. Built on useSyncExternalStore so it never tears and cleans up its
 * listener automatically.
 */
export function useMediaQuery(query: string, serverFallback = false): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () =>
      typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia(query).matches
        : serverFallback,
    () => serverFallback,
  );
}

/**
 * True on the mobile/touch experience (viewport ≤ MOBILE_MAX). `serverFallback`
 * seeds SSR - pass the UA-based hint so a phone gets the mobile tree on first
 * paint instead of flashing the desktop layout for a frame.
 */
export function useIsMobile(serverFallback = false): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_MAX}px)`, serverFallback);
}

/** True when the viewport is at or above the given breakpoint (min-width). */
export function useBreakpointUp(bp: Breakpoint, serverFallback = false): boolean {
  return useMediaQuery(`(min-width: ${BREAKPOINTS[bp]}px)`, serverFallback);
}

/** Honours the user's reduced-motion preference. Defaults to reduced on SSR. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)', true);
}

/**
 * True on a touch device with no hover (phones, most tablets). Used to switch
 * hover-driven affordances to a tap-only model - on touch, the synthetic
 * `mouseenter`/`mouseleave`/`blur` a tap emits otherwise fight a click-toggle
 * (the tap lights then instantly clears). Defaults false on SSR so the desktop
 * hover path renders first, then corrects on the client.
 */
export function useNoHover(): boolean {
  return useMediaQuery('(hover: none)');
}
