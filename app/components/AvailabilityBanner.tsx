import {useEffect, useRef, useState} from 'react';
import {useLocation, useRouteLoaderData} from 'react-router';
import {stableBannerLift, type Box} from '~/lib/avail-banner-lift';
import {
  GEO_BANNER_COPY,
  GEO_BANNER_DISMISSED_KEY,
  availabilityBannerHiddenOn,
  geoBannerLines,
  type GeoAvailabilityRegion,
} from '~/lib/geo-availability';
import type {Locale} from '~/lib/i18n';
import type {RootLoader} from '~/root';

/** Space (px) kept between the card and an element it rises above. */
const GAP = 12;
/** Extra margin before a lifted card drops back (hysteresis), so it never jitters at the boundary. */
const HYSTERESIS = 16;

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
  // Lift above [data-avail-avoid] elements (the homepage hero's wordmark and GitHub link) with a transform
  // only (CSS: translate3d + a 220 ms ease-out, none under prefers-reduced-motion), so the move never changes
  // layout and never shifts the page. Measured once per animation frame at most; every read (card, avoided
  // elements, their styles) happens before the single write. The page's bottom room is a constant CSS
  // reserve ([data-avail-reserve]), never re-measured here, so the footer cannot jump.
  useEffect(() => {
    const el = ref.current;
    if (!el || inline) return;
    let lift = 0;
    let frame = 0;
    const measure = () => {
      frame = 0;
      // reads
      const r = el.getBoundingClientRect();
      const rest: Box = {top: r.top + lift, bottom: r.bottom + lift, left: r.left, right: r.right};
      const strict: Box[] = [];
      const loose: Box[] = [];
      if (r.height > 0) {
        for (const a of document.querySelectorAll<HTMLElement>('[data-avail-avoid]')) {
          const cs = getComputedStyle(a);
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const op = Number(cs.opacity);
          const box = a.getBoundingClientRect();
          if (op > 0) loose.push(box);
          if (op > 0.5) strict.push(box);
        }
      }
      const next = r.height > 0 ? stableBannerLift(lift, rest, strict, loose, window.innerHeight, GAP, HYSTERESIS) : 0;
      // the one write
      if (next !== lift) {
        lift = next;
        el.style.setProperty('--avail-banner-lift', `${lift}px`);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    document.querySelectorAll('[data-avail-avoid]').forEach((a) => ro?.observe(a));
    // The hero wordmark slides into its corner with a CSS transition and fades with the scroll.
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, {passive: true});
    window.addEventListener('wheel', schedule, {passive: true});
    document.addEventListener('transitionend', schedule);
    const mo =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            // Our own --avail-banner-lift write is not a reason to measure again.
            if (records.some((m) => !el.contains(m.target as Node))) schedule();
          });
    mo?.observe(document.body, {subtree: true, childList: true, attributeFilter: ['class', 'style']});
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('wheel', schedule);
      document.removeEventListener('transitionend', schedule);
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
