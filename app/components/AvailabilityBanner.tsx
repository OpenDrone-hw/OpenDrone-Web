import {useEffect, useRef, useState} from 'react';
import {
  GEO_BANNER_COPY,
  GEO_BANNER_DISMISSED_KEY,
  geoBannerLines,
  type GeoAvailabilityRegion,
} from '~/lib/geo-availability';
import type {Locale} from '~/lib/i18n';

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
export function AvailabilityBanner({geo}: {geo: {region: GeoAvailabilityRegion; locale: Locale} | null | undefined}) {
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
    if (!el) return;
    const root = document.documentElement;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const space = r.height > 0 ? Math.max(0, Math.ceil(window.innerHeight - r.top + GAP)) : 0;
      root.style.setProperty('--avail-banner-space', `${space}px`);
    };
    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      root.style.removeProperty('--avail-banner-space');
    };
  }, [dismissed, geo]);
  if (!geo || dismissed) return null;
  const words = GEO_BANNER_COPY[geo.locale];
  const lines = geoBannerLines(geo.region, geo.locale);
  return (
    <section ref={ref} className="avail-banner" aria-label={words.title} data-lines={lines.length} lang={geo.locale}>
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
