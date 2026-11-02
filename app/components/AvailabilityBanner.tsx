import {useEffect, useRef, useState} from 'react';
import {useLocation, useRouteLoaderData} from 'react-router';
import {availBannerLift} from '~/lib/avail-banner-lift';
import {
  GEO_BANNER_COPY,
  GEO_BANNER_DISMISSED_KEY,
  availabilityBannerHiddenOn,
  geoBannerLines,
  type GeoAvailabilityRegion,
} from '~/lib/geo-availability';
import type {Locale} from '~/lib/i18n';
import type {RootLoader} from '~/root';

/** Space (px) kept between the end of the page and the card's top edge. */
const GAP = 12;

/** Remember the dismissal (if storage allows) and hide the card; focus that
 *  was on the card moves to the main content instead of falling to <body>. */
function dismiss(setDismissed: (v: boolean) => void, card: HTMLElement | null) {
  if (card?.contains(document.activeElement)) {
    const main = document.getElementById('main-content');
    main?.setAttribute('tabindex', '-1');
    main?.focus({preventScroll: true});
  }
  try {
    localStorage.setItem(GEO_BANNER_DISMISSED_KEY, '1');
  } catch {
    /* storage blocked: dismissed for this page view only */
  }
  setDismissed(true);
}

/**
 * The site-wide availability card, bottom-left over the page: the visitor's batch line
 * by CF-IPCountry, or both lines, labelled, when the country is unknown
 * (app/lib/geo-availability.ts). Dismissed with its button or Escape and
 * remembered in localStorage; the inline script in root.tsx hides it before
 * first paint for a visitor who dismissed it, so the page does not jump.
 */
export function AvailabilityBanner({
  geo,
  inline = false,
}: {
  geo: {region: GeoAvailabilityRegion; locale: Locale} | null | undefined;
  /** Phone layout: a card in the page flow (CSS shows it only where the fixed card is hidden). */
  inline?: boolean;
}) {
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    try {
      if (localStorage.getItem(GEO_BANNER_DISMISSED_KEY) === '1') setDismissed(true);
    } catch {
      /* storage blocked: the banner shows until dismissed on this page */
    }
  }, []);
  // Escape while focus is inside the card (on its close button) dismisses it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss(setDismissed, el);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [dismissed]);
  // Reserve the room the card covers at the bottom of the viewport (card height + its bottom offset
  // --avail-banner-offset + a GAP so content ends clearly above it) as
  // --avail-banner-space on <html>, so the page can always be scrolled clear of it. 0 while it is hidden
  // (display:none from the pre-paint dismissal style, or on phones behind a bottom bar); removed on unmount.
  useEffect(() => {
    const el = ref.current;
    // The in-flow phone card reserves no space and never needs lifting.
    if (!el || inline) return;
    const root = document.documentElement;
    let lift = 0;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      // The card's box at rest: undo the current lift.
      const rest = {top: r.top + lift, bottom: r.bottom + lift, left: r.left, right: r.right};
      const space = r.height > 0 ? Math.max(0, Math.ceil(window.innerHeight - rest.top + GAP)) : 0;
      root.style.setProperty('--avail-banner-space', `${space}px`);
      // Rise above elements that must stay visible (data-avail-avoid), measured, never a fixed px value.
      const avoid = r.height > 0 ? [...document.querySelectorAll<HTMLElement>('[data-avail-avoid]')]
        .filter((a) => getComputedStyle(a).visibility !== 'hidden' && Number(getComputedStyle(a).opacity) > 0)
        .map((a) => a.getBoundingClientRect()) : [];
      const next = availBannerLift(rest, avoid, window.innerHeight, GAP);
      if (next !== lift) {
        lift = next;
        el.style.setProperty('--avail-banner-lift', `${lift}px`);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    document.querySelectorAll('[data-avail-avoid]').forEach((a) => ro?.observe(a));
    // The hero wordmark slides into its corner with a CSS transition and fades with the scroll.
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, {passive: true});
    document.addEventListener('transitionend', schedule);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    mo?.observe(document.body, {subtree: true, childList: true, attributeFilter: ['class', 'style']});
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      document.removeEventListener('transitionend', schedule);
      root.style.removeProperty('--avail-banner-space');
    };
  }, [dismissed, geo, inline]);
  if (!geo || dismissed) return null;
  const words = GEO_BANNER_COPY[geo.locale];
  const lines = geoBannerLines(geo.region, geo.locale);
  return (
    <section ref={ref} className={inline ? 'avail-banner avail-banner--inline' : 'avail-banner'} aria-label={words.title} data-lines={lines.length} lang={geo.locale}>
      <p className="avail-banner-lines">
        {lines.map((line) => (
          <span key={line.region} className="avail-banner-line">
            <strong>{line.label}:</strong> {line.text}
          </span>
        ))}
      </p>
      <button type="button" className="avail-banner-close" onClick={() => dismiss(setDismissed, ref.current)} aria-label={words.dismiss}>
        <span aria-hidden="true">×</span>
      </button>
    </section>
  );
}

/**
 * The phone card, in the page flow: placed by the page (top of <main> on most routes, under the
 * hero on the phone homepage) so it never floats over content. Same data, dismissal and
 * /flash + /guides rule as the fixed card; CSS shows exactly one of the two.
 */
export function InlineAvailabilityBanner() {
  const {pathname} = useLocation();
  const root = useRouteLoaderData<RootLoader>('root');
  if (!root?.shopOpen || availabilityBannerHiddenOn(pathname)) return null;
  return <AvailabilityBanner geo={root.geo} inline />;
}
