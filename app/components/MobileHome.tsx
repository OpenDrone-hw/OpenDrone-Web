import {Suspense} from 'react';
import {Await, Link} from 'react-router';
import {motion, useReducedMotion, type MotionProps} from 'motion/react';
import type {ProductCardFragment as CollectionItemFragment} from '~/lib/product-shapes';
import {HeroWordmark} from '~/components/HeroWordmark';
import {ProductItem} from '~/components/ProductItem';
import {AnimatedNumber} from '~/components/AnimatedNumber';
import {Txt} from '~/components/Txt';
import {PRODUCT_CONTENT, isConceptFor} from '~/lib/product-content';
import {useRoadmapStatusResolver} from '~/lib/coming-soon';
import {BOARD_ART_VERSION} from '~/data/board-art-version';
import {assetUrl} from '~/lib/asset-url';

// Downscaled WebP thumbnails written by scripts/export-board-art.mjs next to
// front.png. The stage slot is at most 264 CSS px, so 528 (2x) and 800 (3x)
// cover every phone at a tenth of the 1568 px PNG. Same ?v= cache-bust as
// BoardArt so a regenerated render is refetched.
const boardThumb = (handle: string, w: 528 | 800) =>
  assetUrl(
    `/boards/${handle}/front-w${w}.webp${BOARD_ART_VERSION ? `?v=${BOARD_ART_VERSION}` : ''}`,
  );
// Mirrors .home-mobile-board: width clamp(178px, 54vw, 264px).
const BOARD_THUMB_SIZES = '(min-width: 489px) 264px, 54vw';


/* Below-fold "index" band — the open-hardware ledger in the PDP's
 * spec-table language. Every row is a fact already published elsewhere on
 * the site (open-source page, PDP downloads); the design count is derived
 * from the product-content registry so it can't drift. */
const OPEN_DESIGN_COUNT = Object.values(PRODUCT_CONTENT).filter(
  // Resold parts (`editorial: false`) are catalog, not open designs.
  (c) => c.fileNumber !== '—' && c.editorial !== false,
).length;

/* Row order and which row is derived. Labels are copy
 * (`home.m_ledger_<key>_label`), and so is every value EXCEPT the design
 * count, which is computed from the registry so it can't drift — a value here
 * wins over the copy file. Only that derived count is a quantity worth
 * sweeping; licence versions, tool versions and prices are identifiers/fixed
 * figures and render static. */
const HOME_LEDGER: Array<{key: string; value?: string; countUp?: boolean}> = [
  {
    key: 'designs',
    value: String(OPEN_DESIGN_COUNT).padStart(2, '0'),
    countUp: true,
  },
  {key: 'licence'},
  {key: 'source_format'},
  {key: 'designed_in'},
];

/**
 * Phone homepage (≤768px). The desktop homepage IS the WebGL hero scene +
 * scroll-pinned choreography (DesktopHome in routes/_index.tsx) — ~6.3 MB of
 * GLBs and a scroll story tuned for a mouse, deliberately never loaded on a
 * phone. This is the mobile counterpart: not a plain fallback but a hero in its
 * own right — the animated wordmark, a floating "stack" of the real board
 * renders under a gold glow (the desktop hero's product showcase, distilled),
 * and a Dynamic-Island Shop pill — then a clear path to the flagship line and
 * the full catalogue. No 3D, no scroll tricks: fast, legible, touch-first.
 */
export function MobileHome({
  featured,
}: {
  featured: CollectionItemFragment[] | Promise<CollectionItemFragment[]>;
}) {
  const reduce = useReducedMotion();

  // Staggered entrance: each block rises + fades a beat after the last. Skipped
  // wholesale under prefers-reduced-motion (rendered static, no transform).
  const rise = (i: number): MotionProps =>
    reduce
      ? {}
      : {
          initial: {opacity: 0, y: 18},
          animate: {opacity: 1, y: 0},
          transition: {
            duration: 0.55,
            delay: i * 0.09,
            ease: [0.22, 1, 0.36, 1],
          },
        };

  return (
    <div className="home-mobile">
      <section className="home-mobile-hero">
        {/* Floating board "stack" — the two flagship boards (FC over ESC),
            offset like a mounted stack, on a gold-glow island. The desktop
            hero's rotatable 3D trio, distilled to a still that loads instantly. */}
        <motion.div className="home-mobile-stage" {...rise(0)} aria-hidden="true">
          <span className="home-mobile-glow" />
          {/* Float animation lives on the wrapper, drop-shadow on the img:
              animating transform on the filtered element itself forces weak
              GPUs to re-rasterize the shadow every frame of the infinite loop. */}
          <span className="home-mobile-board-float home-mobile-board-float--rear">
            <img
              className="home-mobile-board"
              src={boardThumb('openesc', 800)}
              srcSet={`${boardThumb('openesc', 528)} 528w, ${boardThumb('openesc', 800)} 800w`}
              sizes={BOARD_THUMB_SIZES}
              alt=""
              width={520}
              height={520}
              loading="eager"
              fetchPriority="low"
              decoding="async"
            />
          </span>
          <span className="home-mobile-board-float home-mobile-board-float--front">
            <img
              className="home-mobile-board"
              src={boardThumb('openfc-lite', 800)}
              srcSet={`${boardThumb('openfc-lite', 528)} 528w, ${boardThumb('openfc-lite', 800)} 800w`}
              sizes={BOARD_THUMB_SIZES}
              alt=""
              width={520}
              height={520}
              loading="eager"
              fetchPriority="high"
              decoding="async"
            />
          </span>
        </motion.div>

        <motion.h1
          className="home-mobile-wordmark"
          aria-label="OpenDrone"
          {...rise(1)}
        >
          <HeroWordmark progress={1} className="is-filled" />
        </motion.h1>

        <Txt
          id="home.m_tagline"
          as={motion.p}
          className="home-mobile-tagline"
          {...rise(2)}
        />

        {/* Two full-width actions side by side — Shop (gold) + GitHub (ghost).
            Each is its own pill spanning half the row, not nested in one pod. */}
        <motion.div className="home-mobile-cta" {...rise(3)}>
          <Link
            prefetch="viewport"
            to="/collections/all"
            className="home-mobile-cta-btn home-mobile-cta-shop"
          >
            <Txt id="home.shop" />
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </Link>
          <a
            href="https://github.com/OpenDrone-hw"
            target="_blank"
            rel="noopener noreferrer"
            className="home-mobile-cta-btn home-mobile-cta-github"
            aria-label="View source on GitHub"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            <Txt id="home.m_github" />
          </a>
        </motion.div>
      </section>

      {/* The loader resolves `featured` for a mobile UA, so the cards render
          in the shell here with no Suspense boundary: React's streaming
          renderer outlines any boundary once the shell passes its progressive
          chunk size, so a resolved value inside <Await> still arrived as a
          late chunk and shifted the ledger below (CLS 0.22). A promise (the
          desktop-first path resized down to a phone) still streams. */}
      {Array.isArray(featured) ? (
        <FeaturedGrid items={featured} />
      ) : (
        <Suspense fallback={null}>
          <Await resolve={featured} errorElement={null}>
            {(items) => <FeaturedGrid items={items} />}
          </Await>
        </Suspense>
      )}

      {/* Open-hardware index — spec-table rows (hairline rules, mono keys,
          right-aligned values) with count-ups on the numerals. Reuses the
          PDP's .spec-table so the band IS the house datasheet language. */}
      <section className="home-mobile-ledger" aria-label="Open hardware index">
        <Txt id="home.m_ledger_label" as="p" className="section-label" />
        <dl className="spec-table">
          {HOME_LEDGER.map(({key, value, countUp}) => (
            <div key={key}>
              <Txt id={`home.m_ledger_${key}_label`} as="dt" />
              <dd>
                {value === undefined ? (
                  <Txt id={`home.m_ledger_${key}_value`} />
                ) : countUp ? (
                  <AnimatedNumber value={value} />
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <Link
        prefetch="viewport"
        to="/collections/all"
        className="home-mobile-browse"
      >
        <Txt id="home.m_browse" />
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </Link>
    </div>
  );
}

function FeaturedGrid({items: all}: {items: CollectionItemFragment[]}) {
  // Concept products (planned / in-progress) never list.
  const roadmapStatus = useRoadmapStatusResolver();
  const items = all.filter(
    (p) => !isConceptFor(p.handle, roadmapStatus(p.handle)),
  );
  if (items.length === 0) return null;
  return (
    <section className="home-mobile-featured">
      <Txt id="home.m_featured_label" as="p" className="section-label" />
      <div className="home-mobile-grid">
        {items.map((product, i) => (
          <ProductItem
            key={product.id}
            product={product}
            loading={i === 0 ? 'eager' : 'lazy'}
          />
        ))}
      </div>
    </section>
  );
}
