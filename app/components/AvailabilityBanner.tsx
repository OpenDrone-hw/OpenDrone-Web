import {useEffect, useState} from 'react';
import {GEO_BANNER_COPY, GEO_BANNER_DISMISSED_KEY, geoBarText, type GeoAvailabilityRegion} from '~/lib/geo-availability';
import type {Locale} from '~/lib/i18n';

/**
 * The availability bar: a thin full-width strip at the very top, in the same style as the staging
 * strip (.top-strip), under it when both show. Server-rendered on every page except /flash and
 * /guides/* (PageLayout), so its height is reserved from the first paint (CSS --avail-bar-h): no
 * layout shift. The visitor's batch line by CF-IPCountry, or both lines when the country is unknown
 * (app/lib/geo-availability.ts); a shorter line on phones. Dismissed with its button and remembered
 * in localStorage; the inline script in root.tsx hides it (and zeroes its height) before the first
 * paint for a visitor who dismissed it, so a dismissed bar is never painted.
 */
export function AvailabilityBar({geo, ordinary = false, note = null}: {geo: {region: GeoAvailabilityRegion; locale: Locale} | null | undefined; ordinary?: boolean; note?: string | null}) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(GEO_BANNER_DISMISSED_KEY) === '1') setDismissed(true);
    } catch {
      /* storage blocked: the bar shows until dismissed on this page */
    }
  }, []);
  if (!geo || dismissed) return null;
  const words = GEO_BANNER_COPY[geo.locale];
  const dismiss = () => {
    try {
      localStorage.setItem(GEO_BANNER_DISMISSED_KEY, '1');
    } catch {
      /* storage blocked: dismissed for this page view only */
    }
    // The button unmounts with the bar: hand focus to <main> so the next Tab
    // continues from the page content instead of restarting at the top.
    const main = document.getElementById('main-content');
    if (main) {
      if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
      main.focus({preventScroll: true});
    }
    setDismissed(true);
  };
  return (
    <div className="top-strip avail-bar" role="region" aria-label={words.title} lang={geo.locale}>
      <p className="avail-bar-text">
        <span className="avail-bar-long">{note ?? geoBarText(geo.region, geo.locale, false, ordinary)}</span>
        <span className="avail-bar-short">{note ?? geoBarText(geo.region, geo.locale, true, ordinary)}</span>
      </p>
      <button type="button" className="avail-bar-close" onClick={dismiss} aria-label={words.dismiss}>
        <svg aria-hidden="true" width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M2 2l10 10M12 2L2 12" />
        </svg>
      </button>
    </div>
  );
}
