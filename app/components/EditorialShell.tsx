import type {ReactNode} from 'react';
import {useEffect, useLayoutEffect, useRef} from 'react';

// Arm the cascade BEFORE the browser paints the post-hydration frame:
// hydration strips the pre-paint blanket style, and a plain useEffect
// would leave one visible frame between that and the arming. On the
// server (no layout), fall back so React doesn't warn.
const useBeforePaint =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;
import {Link} from 'react-router';
import {BrandWatermark} from '~/components/BrandWatermark';
import {EDITORIAL_SERIES, nextInSeries} from '~/lib/editorial-index';

/**
 * Three-column reading frame for the long-form pages.
 *
 *   [ series rail ] [ prose, 720px measure ] [ page visual ]
 *
 * The prose column is unchanged: `.editorial-page` still owns the measure,
 * so a page can adopt the shell without its copy reflowing. The rail is the
 * table of contents for the whole series (where am I, what else is there,
 * how long is each), and the aside is whatever picture that page's argument
 * deserves.
 *
 * It degrades by dropping columns, not by hiding content: below 1360px the
 * rail moves under the prose as a "keep reading" list, and below 1120px the
 * aside stacks under the prose too. Nothing is display:none at any width.
 */
// Client-side navigation survives module state; a hard refresh resets it,
// which is exactly the lifetime the entrance animation should have.
const seenSlugs = new Set<string>();

export function EditorialShell({
  slug,
  aside,
  pageClassName,
  children,
  rail = true,
}: {
  /** This page's slug, matched against EDITORIAL_SERIES. */
  slug: string;
  /** The page's visual column. Omit and the shell runs two-column. */
  aside?: ReactNode;
  /** Extra class on the prose column, e.g. timeline-page. */
  pageClassName?: string;
  children: ReactNode;
  /** Render the series strip. Pages that place it themselves (the roadmap
   *  puts it above its board band) pass false. */
  rail?: boolean;
}) {
  const shellRef = useRef<HTMLDivElement>(null);

  // Reading cascade. Every block in the prose column reveals as the reader
  // reaches it: blocks that enter the viewport together (a whole page on a
  // tall screen) stagger top-to-bottom at reading pace, blocks that arrive
  // by scrolling appear on cue. The margin sketch of a section starts its
  // stroke draw on the same cue, so drawing and reading share a clock.
  // Armed entirely at runtime: without JS everything is simply visible, and
  // reduced-motion readers never enter the system at all.
  useBeforePaint(() => {
    const root = shellRef.current;
    if (!root) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // One performance per page per session. Re-arming on every client-side
    // navigation made already-read paragraphs vanish and fade back in when
    // the reader returned to a page - the cascade is a greeting, not a tic.
    // On a seen page, force-reveal instead of merely skipping: the DOM may
    // still carry armed (hidden) items from a previous effect run of this
    // same mount (StrictMode re-runs effects without rebuilding the DOM,
    // which left whole pages invisible).
    if (seenSlugs.has(slug)) {
      root
        .querySelectorAll('.reveal-item')
        .forEach((el) => el.classList.add('is-revealed', 'is-drawn'));
      root.classList.add('cascade-armed');
      return;
    }
    const items = Array.from(
      root.querySelectorAll(
        '.editorial-hero > *, .editorial-section > *, .editorial-cta > *',
      ),
    );
    const io = new IntersectionObserver(
      (entries) => {
        const entering = entries
          .filter((e) => e.isIntersecting)
          .map((e) => e.target as HTMLElement)
          .sort(
            (a, b) =>
              a.getBoundingClientRect().top - b.getBoundingClientRect().top,
          );
        // The page counts as SEEN once the first reveal actually plays for
        // the user - not at arm time, or a re-run of this effect (dev
        // StrictMode) would skip before anything ever showed.
        if (entering.length > 0) seenSlugs.add(slug);
        entering.forEach((el, i) => {
          el.style.setProperty('--rv-d', `${Math.min(i, 14) * 110}ms`);
          el.classList.add('is-revealed');
          if (el.classList.contains('section-art')) el.classList.add('is-drawn');
          io.unobserve(el);
        });
      },
      {rootMargin: '0px 0px -8% 0px'},
    );
    // Only the hero and the FIRST chapter greet the reader; everything
    // below arms when scrolling starts. A tall viewport otherwise floods
    // the whole page in at once, and the page should unfold as it is read.
    const firstSection = root.querySelector('.editorial-section');
    const immediate: Element[] = [];
    const later: Element[] = [];
    for (const el of items) {
      const parent = el.parentElement;
      (parent?.classList.contains('editorial-hero') || parent === firstSection
        ? immediate
        : later
      ).push(el);
    }
    for (const el of items) el.classList.add('reveal-item');
    // The per-element opacity system has the page now; lift the pre-paint
    // CSS blanket that hid the below-first-chapter content (see the
    // html.js rules in app.css) in the same frame.
    root.classList.add('cascade-armed');
    for (const el of immediate) io.observe(el);
    const armLater = () => {
      for (const el of later) io.observe(el);
    };
    window.addEventListener('scroll', armLater, {passive: true, once: true});
    return () => {
      window.removeEventListener('scroll', armLater);
      io.disconnect();
      // Leave no one hidden behind: if this effect armed elements and the
      // next run decides to skip (seen page), stale .reveal-item classes
      // would keep them at opacity 0 forever.
      for (const el of items) el.classList.remove('reveal-item');
      root.classList.remove('cascade-armed');
    };
  }, [slug]);

  return (
    <div className={`editorial-shell${aside ? '' : ' is-narrow'}`} ref={shellRef}>
      <BrandWatermark />
      <div className={`editorial-page${pageClassName ? ` ${pageClassName}` : ''}`}>
        {children}
        <EditorialNext slug={slug} />
      </div>
      {aside ? <aside className="editorial-aside">{aside}</aside> : null}
      {rail ? <SeriesRail slug={slug} /> : null}
    </div>
  );
}

/**
 * The series index. Rendered after the prose in DOM order so a screen
 * reader and a phone both get the article first; CSS `order` lifts it into
 * the left column on wide viewports.
 *
 * Number and title only. The hooks and reading times live in the data for
 * the end-of-page hand-off card; putting them in the rail made it a wall
 * of small text competing with the article.
 */
export function SeriesRail({slug}: {slug: string}) {
  return (
    <nav className="series-rail" aria-label="Reading series">
      <ol className="series-rail-list">
        {EDITORIAL_SERIES.map((entry, i) => {
          const current = entry.slug === slug;
          return (
            <li key={entry.slug} className={current ? 'is-current' : undefined}>
              <Link
                prefetch="viewport"
                to={`/${entry.slug}`}
                aria-current={current ? 'page' : undefined}
              >
                <span className="series-rail-num">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="series-rail-title">{entry.title}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** End-of-page hand-off to the next entry. The thing that keeps a reader going. */
function EditorialNext({slug}: {slug: string}) {
  const next = nextInSeries(slug);
  if (!next) return null;
  return (
    <Link prefetch="viewport" to={`/${next.slug}`} className="editorial-next">
      <span className="editorial-next-label">Next in the series</span>
      <span className="editorial-next-title">{next.title}</span>
      <span className="editorial-next-hook">{next.hook}</span>
      <span className="editorial-next-min">{next.minutes} min read →</span>
    </Link>
  );
}
